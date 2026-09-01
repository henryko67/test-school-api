const { ObjectId } = require('mongodb');

/**
 * Encodes the compound newest-first pagination position of a comment.
 *
 * @param {{created_at: Date, _id: import('mongodb').ObjectId}} comment
 * @returns {string} Opaque base64url cursor.
 */
function encodeCommentCursor(comment) {
  return Buffer.from(
    JSON.stringify({
      created_at: comment.created_at.toISOString(),
      _id: comment._id.toString()
    })
  ).toString('base64url');
}

/**
 * Decodes and validates an opaque comment cursor.
 *
 * @param {string} cursor
 * @returns {{created_at: Date, _id: import('mongodb').ObjectId}|null}
 */
function decodeCommentCursor(cursor) {
  try {
    const decoded = JSON.parse(
      Buffer.from(cursor, 'base64url').toString('utf8')
    );
    const createdAt = new Date(decoded.created_at);

    if (
      Number.isNaN(createdAt.getTime()) ||
      !ObjectId.isValid(decoded._id)
    ) {
      return null;
    }

    return {
      created_at: createdAt,
      _id: new ObjectId(decoded._id)
    };
  } catch {
    return null;
  }
}

/**
 * Builds the MongoDB filter for records after a compound pagination position.
 *
 * @param {{created_at: Date, _id: import('mongodb').ObjectId}} cursor
 * @returns {object} MongoDB `$or` filter matching older comments.
 */
function createCommentCursorFilter(cursor) {
  // The compound sort key keeps pagination stable when comments share a
  // timestamp; callers must sort by created_at and _id in the same direction.
  return {
    $or: [
      {
        created_at: {
          $lt: cursor.created_at
        }
      },
      {
        created_at: cursor.created_at,
        _id: {
          $lt: cursor._id
        }
      }
    ]
  };
}

module.exports = {
  createCommentCursorFilter,
  decodeCommentCursor,
  encodeCommentCursor
};
