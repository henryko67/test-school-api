const { handler: searchHandler } = require('../lambda/search/handler');
const { handler: schoolsHandler } = require('../lambda/schools/handler');
const { handler: usersHandler } = require('../lambda/users/handler');
const { handler: commentsHandler } = require('../lambda/comments/handler');

function httpEvent(method, path, options = {}) {
  return {
    rawPath: path,
    rawQueryString: '',
    headers: {},
    requestContext: { http: { method } },
    ...options
  };
}

describe('grouped Lambda route dispatch', () => {
  test('search handler owns GET /api/search', async () => {
    const response = await searchHandler(httpEvent('GET', '/api/search'));

    expect(response.statusCode).toBe(400);
    expect(JSON.parse(response.body)).toEqual({
      error: 'Missing search query'
    });
  });

  test('schools handler owns the base school route', async () => {
    const response = await schoolsHandler(
      httpEvent('GET', '/api/schools/invalid/id')
    );

    expect(response.statusCode).toBe(400);
    expect(JSON.parse(response.body)).toEqual({
      error: 'Invalid school sector'
    });
  });

  test('schools handler keeps CRDC details public-only', async () => {
    const response = await schoolsHandler(
      httpEvent('GET', '/api/schools/private/ncessch/details')
    );

    expect(response.statusCode).toBe(400);
    expect(JSON.parse(response.body)).toEqual({
      error: 'Detailed CRDC data is only available for public schools'
    });
  });

  test('users handler requires auth for POST /api/users', async () => {
    const response = await usersHandler(
      httpEvent('POST', '/api/users', { body: '{}' })
    );

    expect(response.statusCode).toBe(401);
    expect(JSON.parse(response.body)).toEqual({
      error: 'Authorization header required'
    });
  });

  test('comments handler keeps school reads optional-auth', async () => {
    const response = await commentsHandler(
      httpEvent('GET', '/api/schools/invalid/id/comments')
    );

    expect(response.statusCode).toBe(400);
    expect(JSON.parse(response.body)).toEqual({
      error: 'Invalid school sector'
    });
  });

  test('comments handler requires auth for comment writes', async () => {
    const response = await commentsHandler(
      httpEvent('POST', '/api/schools/public/id/comments', {
        body: JSON.stringify({ text: 'Hello' })
      })
    );

    expect(response.statusCode).toBe(401);
    expect(JSON.parse(response.body)).toEqual({
      error: 'Authorization header required'
    });
  });

  test('development-only routes are not migrated', async () => {
    const responses = await Promise.all([
      searchHandler(httpEvent('GET', '/api/test')),
      usersHandler(httpEvent('GET', '/api/auth/test'))
    ]);

    expect(responses.map(response => response.statusCode)).toEqual([404, 404]);
  });
});
