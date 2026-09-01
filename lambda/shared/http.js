class InvalidJsonBodyError extends Error {
  constructor() {
    super('Invalid JSON request body');
    this.name = 'InvalidJsonBodyError';
  }
}

/**
 * Normalizes header names for case-insensitive API Gateway access.
 *
 * @param {Record<string, string|undefined>} [headers]
 * @returns {Record<string, string|undefined>}
 */
function normalizeHeaders(headers = {}) {
  return Object.fromEntries(
    Object.entries(headers || {}).map(([name, value]) => [
      name.toLowerCase(),
      value
    ])
  );
}

function parseQueryString(rawQueryString = '') {
  return Object.fromEntries(new URLSearchParams(rawQueryString));
}

/**
 * Parses an API Gateway body, including base64-encoded proxy payloads.
 *
 * @param {object} event
 * @returns {object} Parsed JSON, or an empty object when no body was supplied.
 * @throws {InvalidJsonBodyError} When a string body is not valid JSON.
 */
function parseJsonBody(event) {
  if (event.body === undefined || event.body === null || event.body === '') {
    return {};
  }

  const rawBody = event.isBase64Encoded
    ? Buffer.from(event.body, 'base64').toString('utf8')
    : event.body;

  if (typeof rawBody === 'object') {
    return rawBody;
  }

  try {
    return JSON.parse(rawBody);
  } catch {
    throw new InvalidJsonBodyError();
  }
}

/**
 * Converts HTTP API v2 or REST API proxy events into the request contract used
 * by all grouped route handlers.
 *
 * @param {object} event
 * @returns {{method: string, path: string, pathParameters: object, query: object, headers: object, authorization: (string|undefined), body: object, event: object}}
 */
function normalizeRequest(event) {
  const headers = normalizeHeaders(event.headers);

  return {
    method:
      event.requestContext?.http?.method ||
      event.httpMethod ||
      '',
    path: event.rawPath || event.path || '/',
    pathParameters: event.pathParameters || {},
    query:
      event.queryStringParameters ||
      parseQueryString(event.rawQueryString),
    headers,
    authorization: headers.authorization,
    body: parseJsonBody(event),
    event
  };
}

/**
 * Creates an API Gateway JSON proxy response.
 *
 * @param {number} statusCode
 * @param {*} body A JSON-serializable response body.
 * @param {Record<string, string>} [additionalHeaders]
 * @returns {{statusCode: number, headers: Record<string, string>, body: string}}
 */
function jsonResponse(statusCode, body, additionalHeaders = {}) {
  return {
    statusCode,
    headers: {
      'Content-Type': 'application/json',
      ...additionalHeaders
    },
    body: JSON.stringify(body)
  };
}

module.exports = {
  InvalidJsonBodyError,
  jsonResponse,
  normalizeHeaders,
  normalizeRequest,
  parseJsonBody
};
