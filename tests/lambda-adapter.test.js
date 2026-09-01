const {
  InvalidJsonBodyError,
  jsonResponse,
  normalizeRequest
} = require('../lambda/shared/http');
const { requireAuthenticatedUser } = require('../lambda/shared/auth');
const { createLambdaHandler } = require('../lambda/shared/handler');
const { createRouter } = require('../lambda/shared/router');

describe('API Gateway request normalization', () => {
  test('normalizes HTTP API v2 events and headers case-insensitively', () => {
    const request = normalizeRequest({
      version: '2.0',
      rawPath: '/api/schools/public/123',
      rawQueryString: 'before=abc&q=Seattle',
      headers: {
        Authorization: 'Bearer token',
        'Content-Type': 'application/json'
      },
      requestContext: {
        http: { method: 'POST' }
      },
      body: JSON.stringify({ text: 'Hello' })
    });

    expect(request.method).toBe('POST');
    expect(request.path).toBe('/api/schools/public/123');
    expect(request.query).toEqual({ before: 'abc', q: 'Seattle' });
    expect(request.authorization).toBe('Bearer token');
    expect(request.headers['content-type']).toBe('application/json');
    expect(request.body).toEqual({ text: 'Hello' });
  });

  test('normalizes REST API proxy events and base64 bodies', () => {
    const request = normalizeRequest({
      httpMethod: 'PATCH',
      path: '/api/users/me',
      pathParameters: {},
      queryStringParameters: { source: 'settings' },
      headers: { authorization: 'Bearer token' },
      isBase64Encoded: true,
      body: Buffer.from(JSON.stringify({ username: 'HenryK' })).toString(
        'base64'
      )
    });

    expect(request.method).toBe('PATCH');
    expect(request.path).toBe('/api/users/me');
    expect(request.query).toEqual({ source: 'settings' });
    expect(request.body).toEqual({ username: 'HenryK' });
  });

  test('rejects malformed JSON bodies', () => {
    expect(() =>
      normalizeRequest({
        httpMethod: 'POST',
        path: '/api/users',
        body: '{bad json'
      })
    ).toThrow(InvalidJsonBodyError);
  });
});

describe('Lambda response formatting', () => {
  test('formats JSON proxy responses', () => {
    expect(jsonResponse(201, { message: 'created' })).toEqual({
      statusCode: 201,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'created' })
    });
  });
});

describe('Lambda route dispatch', () => {
  test('matches method and route parameters', async () => {
    const routeHandler = jest.fn(request =>
      jsonResponse(200, { id: request.pathParameters.id })
    );
    const router = createRouter([
      {
        method: 'GET',
        path: '/api/comments/:id',
        handler: routeHandler
      }
    ]);
    const handler = createLambdaHandler(router);
    const response = await handler({
      rawPath: '/api/comments/abc%20123',
      requestContext: { http: { method: 'GET' } }
    });

    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body)).toEqual({ id: 'abc 123' });
    expect(routeHandler).toHaveBeenCalledTimes(1);
  });

  test('returns 404 for an unowned route', async () => {
    const handler = createLambdaHandler(createRouter([]));
    const response = await handler({
      rawPath: '/not-owned',
      requestContext: { http: { method: 'GET' } }
    });

    expect(response.statusCode).toBe(404);
    expect(JSON.parse(response.body)).toEqual({ error: 'Not found' });
  });
});

describe('Lambda authentication wrapper', () => {
  test('preserves the missing Authorization response', async () => {
    const result = await requireAuthenticatedUser({});

    expect(result.response.statusCode).toBe(401);
    expect(JSON.parse(result.response.body)).toEqual({
      error: 'Authorization header required'
    });
  });

  test('preserves the malformed Authorization response', async () => {
    const result = await requireAuthenticatedUser({
      authorization: 'Basic credentials'
    });

    expect(result.response.statusCode).toBe(401);
    expect(JSON.parse(result.response.body)).toEqual({
      error: 'Invalid authorization header'
    });
  });
});
