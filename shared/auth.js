const { CognitoJwtVerifier } = require('aws-jwt-verify');
const config = require('./config');

const jwtVerifier = CognitoJwtVerifier.create({
  userPoolId: config.cognito.userPoolId,
  tokenUse: 'access',
  clientId: config.cognito.clientId
});

/**
 * Parses a strict Cognito bearer header.
 *
 * @param {*} authHeader
 * @returns {string|null} The token without its scheme, or `null`.
 */
function parseBearerToken(authHeader) {
  if (typeof authHeader !== 'string') {
    return null;
  }

  const [scheme, token] = authHeader.split(' ');

  if (scheme !== 'Bearer' || !token) {
    return null;
  }

  return token;
}

function parseOptionalBearerToken(authHeader) {
  if (
    typeof authHeader !== 'string' ||
    !authHeader.startsWith('Bearer ')
  ) {
    return null;
  }

  return authHeader.substring(7);
}

/**
 * Verifies a required Cognito access token and rejects when it is invalid.
 *
 * @param {string} token
 * @returns {Promise<object>} Verified JWT payload.
 */
async function verifyRequiredToken(token) {
  return jwtVerifier.verify(token);
}

/**
 * Verifies optional Cognito credentials without turning invalid credentials
 * into a request failure.
 *
 * @param {string|null} token
 * @returns {Promise<object|null>} Verified JWT payload, or `null`.
 */
async function verifyOptionalToken(token) {
  if (!token) {
    return null;
  }

  try {
    return await jwtVerifier.verify(token);
  } catch {
    return null;
  }
}

module.exports = {
  jwtVerifier,
  parseBearerToken,
  parseOptionalBearerToken,
  verifyOptionalToken,
  verifyRequiredToken
};
