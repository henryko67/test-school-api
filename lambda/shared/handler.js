const {
  InvalidJsonBodyError,
  jsonResponse,
  normalizeRequest
} = require('./http');

/**
 * Wraps a normalized-request router as an API Gateway proxy handler.
 * Converts malformed JSON and otherwise-unhandled failures into JSON responses.
 *
 * @param {(request: object) => Promise<object|null>} router
 * @returns {(event: object) => Promise<{statusCode: number, headers: object, body: string}>}
 */
function createLambdaHandler(router) {
  return async event => {
    try {
      const request = normalizeRequest(event);
      const response = await router(request);

      return response || jsonResponse(404, {
        error: 'Not found'
      });
    } catch (error) {
      if (error instanceof InvalidJsonBodyError) {
        return jsonResponse(400, {
          error: 'Invalid JSON request body'
        });
      }

      console.error('Unhandled Lambda request error:', error);

      return jsonResponse(500, {
        error: 'Internal server error'
      });
    }
  };
}

module.exports = {
  createLambdaHandler
};
