require('dotenv').config();

const crypto = require('crypto');
const config = require('../../shared/config');
const { isValidSchoolSector } = require('../../shared/validation');
const { requireAuthenticatedUser } = require('../shared/auth');
const { createLambdaHandler } = require('../shared/handler');
const { jsonResponse } = require('../shared/http');
const { createRouter } = require('../shared/router');
const {
  consumeTicket,
  deleteConnectionState,
  storeConnection,
  storeTicket,
  subscribeToSchool,
  unsubscribeFromSchool
} = require('./state');

function unixTimeSeconds() {
  return Math.floor(Date.now() / 1000);
}

function websocketResponse(statusCode = 200) {
  return { statusCode };
}

function parseWebSocketMessage(event) {
  if (!event.body) {
    return {};
  }

  try {
    return JSON.parse(event.body);
  } catch {
    return null;
  }
}

function validSchoolSubscription(message) {
  return (
    message &&
    isValidSchoolSector(message.sector) &&
    typeof message.school_id === 'string' &&
    message.school_id.length > 0
  );
}

/**
 * Creates a 60-second, single-use WebSocket ticket for an authenticated HTTP
 * API request.
 *
 * @param {object} request Normalized Lambda HTTP request.
 * @returns {Promise<object>} API Gateway JSON proxy response.
 */
async function createTicket(request) {
  const authentication = await requireAuthenticatedUser(request);

  if (authentication.response) {
    return authentication.response;
  }

  try {
    const ticket = crypto.randomBytes(32).toString('base64url');
    const expiresAt =
      unixTimeSeconds() + config.websocket.ticketTtlSeconds;

    await storeTicket(ticket, authentication.user.sub, expiresAt);

    return jsonResponse(200, { ticket });
  } catch (error) {
    console.error('Unable to create WebSocket ticket:', error);
    return jsonResponse(500, { error: 'Unable to create WebSocket ticket' });
  }
}

/**
 * Handles API Gateway `$connect`, optionally consuming a ticket to associate
 * the connection with a Cognito subject.
 *
 * @param {object} event API Gateway WebSocket event.
 * @returns {Promise<{statusCode: number}>}
 */
async function connect(event) {
  const connectionId = event.requestContext?.connectionId;
  const query = event.queryStringParameters || {};
  const ticketWasSupplied = Object.prototype.hasOwnProperty.call(
    query,
    'ticket'
  );
  const ticket = query.ticket;

  if (!connectionId) {
    return websocketResponse(500);
  }

  try {
    const now = unixTimeSeconds();
    let userSub;

    if (ticketWasSupplied) {
      const ticketRecord = await consumeTicket(ticket, now);

      if (!ticketRecord) {
        return websocketResponse(401);
      }

      userSub = ticketRecord.userSub;
    }

    await storeConnection(
      connectionId,
      userSub,
      now,
      now + config.websocket.connectionTtlSeconds
    );

    return websocketResponse(200);
  } catch (error) {
    console.error('Unable to establish WebSocket connection:', error);
    return websocketResponse(500);
  }
}

/**
 * Validates and idempotently stores a school subscription message.
 *
 * @param {object} event API Gateway WebSocket event.
 * @returns {Promise<{statusCode: number}>}
 */
async function subscribeSchool(event) {
  const message = parseWebSocketMessage(event);
  const connectionId = event.requestContext?.connectionId;

  if (!connectionId || !validSchoolSubscription(message)) {
    return websocketResponse(400);
  }

  try {
    await subscribeToSchool(
      connectionId,
      message.sector,
      message.school_id,
      unixTimeSeconds() + config.websocket.connectionTtlSeconds
    );
    return websocketResponse(200);
  } catch (error) {
    console.error('Unable to subscribe WebSocket connection:', error);
    return websocketResponse(500);
  }
}

/**
 * Validates and idempotently removes a school subscription message.
 *
 * @param {object} event API Gateway WebSocket event.
 * @returns {Promise<{statusCode: number}>}
 */
async function unsubscribeSchool(event) {
  const message = parseWebSocketMessage(event);
  const connectionId = event.requestContext?.connectionId;

  if (!connectionId || !validSchoolSubscription(message)) {
    return websocketResponse(400);
  }

  try {
    await unsubscribeFromSchool(
      connectionId,
      message.sector,
      message.school_id
    );
    return websocketResponse(200);
  } catch (error) {
    console.error('Unable to unsubscribe WebSocket connection:', error);
    return websocketResponse(500);
  }
}

/**
 * Attempts reverse-index subscription cleanup for a disconnected client.
 * Cleanup failures are logged but still return success to API Gateway.
 *
 * @param {object} event API Gateway WebSocket event.
 * @returns {Promise<{statusCode: number}>}
 */
async function disconnect(event) {
  const connectionId = event.requestContext?.connectionId;

  if (!connectionId) {
    return websocketResponse(200);
  }

  try {
    await deleteConnectionState(connectionId);
  } catch (error) {
    // API Gateway delivers $disconnect on a best-effort basis. TTL also cleans
    // up records if this attempt is incomplete.
    console.error('Unable to fully clean up WebSocket connection:', error);
  }

  return websocketResponse(200);
}

/**
 * Dispatches an API Gateway WebSocket event by route key. Unsupported actions
 * are acknowledged without mutating state.
 *
 * @param {object} event
 * @returns {Promise<{statusCode: number}>}
 */
async function handleWebSocketEvent(event) {
  switch (event.requestContext?.routeKey) {
    case '$connect':
      return connect(event);
    case '$disconnect':
      return disconnect(event);
    case 'subscribe-school':
      return subscribeSchool(event);
    case 'unsubscribe-school':
      return unsubscribeSchool(event);
    case '$default':
    default:
      return websocketResponse(200);
  }
}

const httpRouter = createRouter([
  {
    method: 'POST',
    path: '/api/websocket-ticket',
    handler: createTicket
  }
]);
const httpHandler = createLambdaHandler(httpRouter);

/**
 * Shared entry point for HTTP API v2 ticket requests and API Gateway WebSocket
 * events.
 *
 * @param {object} event
 * @returns {Promise<object>} API Gateway proxy or WebSocket route response.
 */
async function handler(event) {
  if (event.version === '2.0' || event.requestContext?.http) {
    return httpHandler(event);
  }

  if (event.requestContext?.routeKey) {
    return handleWebSocketEvent(event);
  }

  return jsonResponse(404, { error: 'Not found' });
}

module.exports = {
  connect,
  createTicket,
  disconnect,
  handler,
  handleWebSocketEvent,
  subscribeSchool,
  unsubscribeSchool
};
