require('dotenv').config();

const { connectDatabase } = require('../../shared/mongodb');
const {
  isValidUsername,
  normalizeUsername
} = require('../../shared/validation');
const { requireAuthenticatedUser } = require('../shared/auth');
const { createLambdaHandler } = require('../shared/handler');
const { jsonResponse } = require('../shared/http');
const { createRouter } = require('../shared/router');

/**
 * Creates the MongoDB application profile for a verified Cognito subject.
 * Duplicate subjects and normalized usernames resolve to conflict responses.
 *
 * @param {object} request Authenticated normalized request containing `username`.
 * @returns {Promise<object>} API Gateway JSON proxy response.
 */
async function createUser(request) {
  const authentication = await requireAuthenticatedUser(request);

  if (authentication.response) {
    return authentication.response;
  }

  try {
    const { username } = request.body;

    if (typeof username !== 'string') {
      return jsonResponse(400, { error: 'Username is required' });
    }

    if (!isValidUsername(username)) {
      return jsonResponse(400, {
        error:
          'Username must be 3-20 characters and contain only letters, numbers, and underscores'
      });
    }

    const user = {
      cognito_sub: authentication.user.sub,
      username: username.trim(),
      username_normalized: normalizeUsername(username),
      created_at: new Date()
    };
    const { users } = await connectDatabase();

    await users.insertOne(user);

    return jsonResponse(201, {
      message: 'User profile created',
      user
    });
  } catch (error) {
    if (error.code === 11000) {
      if (error.keyPattern?.cognito_sub) {
        return jsonResponse(409, {
          error: 'A profile already exists for this account'
        });
      }

      if (error.keyPattern?.username_normalized) {
        return jsonResponse(409, { error: 'Username is already taken' });
      }

      return jsonResponse(409, { error: 'User profile already exists' });
    }

    console.error('Error creating user profile:', error);
    return jsonResponse(500, { error: 'Unable to create user profile' });
  }
}

/**
 * Checks case-insensitive username availability after applying application
 * username validation and normalization.
 *
 * @param {object} request Normalized request containing a `username` query value.
 * @returns {Promise<object>} API Gateway JSON proxy response.
 */
async function usernameAvailable(request) {
  try {
    const username = request.query.username;

    if (typeof username !== 'string') {
      return jsonResponse(400, { error: 'Username is required' });
    }

    if (!isValidUsername(username)) {
      return jsonResponse(400, {
        error:
          'Username must be 3-20 characters and contain only letters, numbers, and underscores'
      });
    }

    const { users } = await connectDatabase();
    const existingUser = await users.findOne({
      username_normalized: normalizeUsername(username)
    });

    return jsonResponse(200, { available: !existingUser });
  } catch (error) {
    console.error('Username availability check failed:', error);
    return jsonResponse(500, {
      error: 'Unable to check username availability'
    });
  }
}

/**
 * Retrieves the MongoDB profile mapped to the authenticated Cognito subject.
 *
 * @param {object} request Authenticated normalized request.
 * @returns {Promise<object>} API Gateway JSON proxy response.
 */
async function getCurrentUser(request) {
  const authentication = await requireAuthenticatedUser(request);

  if (authentication.response) {
    return authentication.response;
  }

  try {
    const { users } = await connectDatabase();
    const user = await users.findOne({
      cognito_sub: authentication.user.sub
    });

    if (!user) {
      return jsonResponse(404, { error: 'User profile not found' });
    }

    return jsonResponse(200, { user });
  } catch (error) {
    console.error('Error retrieving user profile:', error);
    return jsonResponse(500, { error: 'Unable to retrieve user profile' });
  }
}

/**
 * Updates the authenticated user's display and normalized usernames together.
 *
 * @param {object} request Authenticated normalized request containing `username`.
 * @returns {Promise<object>} API Gateway JSON proxy response.
 */
async function updateCurrentUser(request) {
  const authentication = await requireAuthenticatedUser(request);

  if (authentication.response) {
    return authentication.response;
  }

  try {
    const username =
      typeof request.body.username === 'string'
        ? request.body.username.trim()
        : '';

    if (
      username.length < 3 ||
      username.length > 20 ||
      !/^[a-zA-Z0-9_]+$/.test(username)
    ) {
      return jsonResponse(400, {
        error:
          'Username must be 3-20 characters and contain only letters, numbers, and underscores.'
      });
    }

    const { users } = await connectDatabase();
    const result = await users.findOneAndUpdate(
      { cognito_sub: authentication.user.sub },
      {
        $set: {
          username,
          username_normalized: normalizeUsername(username)
        }
      },
      { returnDocument: 'after' }
    );

    if (!result) {
      return jsonResponse(404, { error: 'User profile not found' });
    }

    return jsonResponse(200, { user: result });
  } catch (error) {
    if (error?.code === 11000) {
      return jsonResponse(409, { error: 'Username is already taken' });
    }

    console.error('Error updating username:', error);
    return jsonResponse(500, { error: 'Unable to update username' });
  }
}

const router = createRouter([
  { method: 'POST', path: '/api/users', handler: createUser },
  {
    method: 'GET',
    path: '/api/users/username-available',
    handler: usernameAvailable
  },
  { method: 'GET', path: '/api/users/me', handler: getCurrentUser },
  { method: 'PATCH', path: '/api/users/me', handler: updateCurrentUser }
]);

module.exports = {
  createUser,
  getCurrentUser,
  handler: createLambdaHandler(router),
  updateCurrentUser,
  usernameAvailable
};
