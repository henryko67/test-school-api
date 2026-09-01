const {
  parseBearerToken,
  parseOptionalBearerToken,
  verifyOptionalToken,
  verifyRequiredToken
} = require('../../shared/auth');
const { jsonResponse } = require('./http');

/**
 * Enforces Cognito access-token authentication for a normalized request.
 * Authentication failures resolve to `{response}`, while success resolves to
 * `{user}` containing the verified JWT payload.
 *
 * @param {{authorization?: string}} request
 * @returns {Promise<{user: object}|{response: object}>}
 */
async function requireAuthenticatedUser(request) {
  // Authentication proves Cognito identity. Mutation handlers that depend on
  // an application profile must separately verify the Cognito sub in MongoDB.
  if (!request.authorization) {
    return {
      response: jsonResponse(401, {
        error: 'Authorization header required'
      })
    };
  }

  const token = parseBearerToken(request.authorization);

  if (!token) {
    return {
      response: jsonResponse(401, {
        error: 'Invalid authorization header'
      })
    };
  }

  try {
    return {
      user: await verifyRequiredToken(token)
    };
  } catch (error) {
    console.error('Error verifying JWT:', error);

    return {
      response: jsonResponse(401, {
        error: 'Invalid or expired token'
      })
    };
  }
}

/**
 * Resolves the verified JWT payload when optional bearer authentication is
 * valid; missing or invalid credentials resolve to `null`.
 *
 * @param {{authorization?: string}} request
 * @returns {Promise<object|null>}
 */
async function getOptionalUser(request) {
  if (!request.authorization) {
    return null;
  }

  const token = parseOptionalBearerToken(request.authorization);
  return verifyOptionalToken(token);
}

module.exports = {
  getOptionalUser,
  requireAuthenticatedUser
};
