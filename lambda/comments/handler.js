require('dotenv').config();

const { ObjectId } = require('mongodb');
const {
  createCommentCursorFilter,
  decodeCommentCursor,
  encodeCommentCursor
} = require('../../shared/comment-cursor');
const {
  enrichCommentsWithSchoolNames
} = require('../../shared/comments');
const { connectDatabase } = require('../../shared/mongodb');
const { isValidSchoolSector } = require('../../shared/validation');
const {
  getOptionalUser,
  requireAuthenticatedUser
} = require('../shared/auth');
const { createLambdaHandler } = require('../shared/handler');
const { jsonResponse } = require('../shared/http');
const { notifyCommentMutation } = require('../shared/notifications');
const { createRouter } = require('../shared/router');

async function schoolExists(collections, sector, id) {
  const collection =
    sector === 'public'
      ? collections.publicSchools
      : collections.privateSchools;
  const school = await collection.findOne(
    { _id: id },
    { projection: { _id: 1 } }
  );

  return !!school;
}

async function findUserProfile(collections, cognitoSub) {
  return collections.users.findOne(
    { cognito_sub: cognitoSub },
    { projection: { username: 1 } }
  );
}

function missingUserProfileResponse() {
  return jsonResponse(403, {
    error: 'User profile no longer exists'
  });
}

/**
 * Returns a newest-first cursor page for one school. Authentication is optional
 * and only controls the projected `is_owner` value.
 *
 * @param {object} request Normalized request with school path parameters and optional `before` cursor.
 * @returns {Promise<object>} API Gateway JSON proxy response.
 */
async function getSchoolComments(request) {
  const user = await getOptionalUser(request);

  try {
    const { sector, id } = request.pathParameters;
    const { before } = request.query;

    if (!isValidSchoolSector(sector)) {
      return jsonResponse(400, { error: 'Invalid school sector' });
    }

    const collections = await connectDatabase();

    if (!(await schoolExists(collections, sector, id))) {
      return jsonResponse(404, { error: 'School not found' });
    }

    let cursor = null;

    if (before !== undefined) {
      if (typeof before !== 'string') {
        return jsonResponse(400, { error: 'Invalid comment cursor' });
      }

      cursor = decodeCommentCursor(before);

      if (!cursor) {
        return jsonResponse(400, { error: 'Invalid comment cursor' });
      }
    }

    const match = { sector, school_id: id };

    if (cursor) {
      Object.assign(match, createCommentCursorFilter(cursor));
    }

    const results = await collections.comments
      .aggregate([
        { $match: match },
        { $sort: { created_at: -1, _id: -1 } },
        { $limit: 11 },
        {
          $lookup: {
            from: 'users',
            localField: 'author_sub',
            foreignField: 'cognito_sub',
            as: 'author'
          }
        },
        {
          $unwind: {
            path: '$author',
            preserveNullAndEmptyArrays: true
          }
        },
        {
          $project: {
            _id: 1,
            school_id: 1,
            sector: 1,
            text: 1,
            created_at: 1,
            updated_at: 1,
            author: { username: '$author.username' },
            is_owner: {
              $eq: ['$author_sub', user?.sub ?? null]
            }
          }
        }
      ])
      .toArray();
    const hasMore = results.length > 10;
    const page = results.slice(0, 10);
    const lastComment = page.at(-1);
    const nextCursor =
      hasMore && lastComment ? encodeCommentCursor(lastComment) : null;

    return jsonResponse(200, {
      comments: page,
      hasMore,
      nextCursor
    });
  } catch (error) {
    console.error('Error retrieving comments:', error);
    return jsonResponse(500, { error: 'Unable to retrieve comments' });
  }
}

/**
 * Persists a comment for an authenticated Cognito subject that still has a
 * MongoDB profile, then attempts best-effort realtime notification delivery.
 *
 * @param {object} request Authenticated normalized request containing comment text.
 * @returns {Promise<object>} API Gateway JSON proxy response.
 */
async function createComment(request) {
  const authentication = await requireAuthenticatedUser(request);

  if (authentication.response) {
    return authentication.response;
  }

  try {
    const { sector, id } = request.pathParameters;
    const { text } = request.body;

    if (!isValidSchoolSector(sector)) {
      return jsonResponse(400, { error: 'Invalid school sector' });
    }

    const collections = await connectDatabase();

    if (!(await schoolExists(collections, sector, id))) {
      return jsonResponse(404, { error: 'School not found' });
    }

    if (typeof text !== 'string' || text.trim().length === 0) {
      return jsonResponse(400, { error: 'Comment text is required' });
    }

    // A still-valid JWT can outlive deletion of the application's Mongo
    // profile, so mutations require both Cognito identity and profile presence.
    const author = await findUserProfile(
      collections,
      authentication.user.sub
    );

    if (!author) {
      return missingUserProfileResponse();
    }

    const comment = {
      school_id: id,
      sector,
      author_sub: authentication.user.sub,
      text,
      created_at: new Date(),
      updated_at: new Date()
    };
    const result = await collections.comments.insertOne(comment);

    comment._id = result.insertedId;

    const publicComment = {
      _id: comment._id,
      school_id: comment.school_id,
      sector: comment.sector,
      text: comment.text,
      created_at: comment.created_at,
      updated_at: comment.updated_at,
      author: { username: author.username ?? 'Unknown user' }
    };

    await notifyCommentMutation({
      event: 'comment-created',
      commentId: comment._id.toString(),
      sector,
      schoolId: id,
      authorSub: authentication.user.sub
    });

    return jsonResponse(201, {
      message: 'Comment created successfully',
      comment: publicComment
    });
  } catch (error) {
    console.error('Error creating comment:', error);
    return jsonResponse(500, { error: 'Unable to create comment' });
  }
}

/**
 * Deletes a comment only when both its author subject and the authenticated
 * user's existing MongoDB profile satisfy the ownership contract.
 *
 * @param {object} request Authenticated normalized request with a comment ObjectId.
 * @returns {Promise<object>} API Gateway JSON proxy response.
 */
async function deleteComment(request) {
  const authentication = await requireAuthenticatedUser(request);

  if (authentication.response) {
    return authentication.response;
  }

  try {
    const { id } = request.pathParameters;
    let commentId;

    try {
      commentId = new ObjectId(id);
    } catch {
      return jsonResponse(400, { error: 'Invalid comment id' });
    }

    const collections = await connectDatabase();
    // Preserve the same profile-presence authorization contract as creation.
    const userProfile = await findUserProfile(
      collections,
      authentication.user.sub
    );

    if (!userProfile) {
      return missingUserProfileResponse();
    }

    const { comments } = collections;
    const deletedComment = await comments.findOneAndDelete({
      _id: commentId,
      author_sub: authentication.user.sub
    });

    if (!deletedComment) {
      return jsonResponse(404, {
        error: 'Comment not found or you do not own this comment'
      });
    }

    await notifyCommentMutation({
      event: 'comment-deleted',
      commentId: deletedComment._id.toString(),
      sector: deletedComment.sector,
      schoolId: deletedComment.school_id,
      authorSub: authentication.user.sub
    });

    return jsonResponse(200, { message: 'Comment deleted' });
  } catch (error) {
    console.error('Error deleting comment:', error);
    return jsonResponse(500, { error: 'Unable to delete comment' });
  }
}

/**
 * Returns a newest-first cursor page of the authenticated user's comments,
 * enriched with public/private school names.
 *
 * @param {object} request Authenticated normalized request with optional `before` cursor.
 * @returns {Promise<object>} API Gateway JSON proxy response.
 */
async function getCurrentUserComments(request) {
  const authentication = await requireAuthenticatedUser(request);

  if (authentication.response) {
    return authentication.response;
  }

  try {
    const { before } = request.query;
    let cursor = null;

    if (before !== undefined) {
      if (typeof before !== 'string') {
        return jsonResponse(400, { error: 'Invalid comment cursor' });
      }

      cursor = decodeCommentCursor(before);

      if (!cursor) {
        return jsonResponse(400, { error: 'Invalid comment cursor' });
      }
    }

    const collections = await connectDatabase();
    const filter = { author_sub: authentication.user.sub };

    if (cursor) {
      Object.assign(filter, createCommentCursorFilter(cursor));
    }

    const results = await collections.comments
      .find(filter)
      .sort({ created_at: -1, _id: -1 })
      .limit(11)
      .toArray();
    const hasMore = results.length > 10;
    const page = results.slice(0, 10);
    const enrichedComments = await enrichCommentsWithSchoolNames(
      page,
      collections.publicSchools,
      collections.privateSchools
    );
    const lastComment = page.at(-1);
    const nextCursor =
      hasMore && lastComment ? encodeCommentCursor(lastComment) : null;

    return jsonResponse(200, {
      comments: enrichedComments,
      hasMore,
      nextCursor
    });
  } catch (error) {
    console.error('Error retrieving user comments:', error);
    return jsonResponse(500, {
      error: 'Unable to retrieve user comments'
    });
  }
}

const router = createRouter([
  {
    method: 'GET',
    path: '/api/schools/:sector/:id/comments',
    handler: getSchoolComments
  },
  {
    method: 'POST',
    path: '/api/schools/:sector/:id/comments',
    handler: createComment
  },
  {
    method: 'DELETE',
    path: '/api/comments/:id',
    handler: deleteComment
  },
  {
    method: 'GET',
    path: '/api/users/me/comments',
    handler: getCurrentUserComments
  }
]);

module.exports = {
  createComment,
  deleteComment,
  getCurrentUserComments,
  getSchoolComments,
  handler: createLambdaHandler(router)
};
