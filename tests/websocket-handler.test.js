const mockVerifyRequiredToken = jest.fn();
const mockConsumeTicket = jest.fn();
const mockDeleteConnectionState = jest.fn();
const mockStoreConnection = jest.fn();
const mockStoreTicket = jest.fn();
const mockSubscribeToSchool = jest.fn();
const mockUnsubscribeFromSchool = jest.fn();

jest.mock('../shared/auth', () => ({
  parseBearerToken: header => {
    const [scheme, token] = (header || '').split(' ');
    return scheme === 'Bearer' && token ? token : null;
  },
  parseOptionalBearerToken: jest.fn(),
  verifyOptionalToken: jest.fn(),
  verifyRequiredToken: mockVerifyRequiredToken
}));

jest.mock('../lambda/websocket/state', () => ({
  consumeTicket: mockConsumeTicket,
  deleteConnectionState: mockDeleteConnectionState,
  storeConnection: mockStoreConnection,
  storeTicket: mockStoreTicket,
  subscribeToSchool: mockSubscribeToSchool,
  unsubscribeFromSchool: mockUnsubscribeFromSchool
}));

const { handler } = require('../lambda/websocket/handler');

function httpEvent(authorization) {
  return {
    version: '2.0',
    rawPath: '/api/websocket-ticket',
    headers: authorization ? { Authorization: authorization } : {},
    requestContext: {
      http: { method: 'POST' },
      routeKey: 'POST /api/websocket-ticket'
    }
  };
}

function websocketEvent(routeKey, options = {}) {
  return {
    requestContext: {
      routeKey,
      connectionId: 'connection-1'
    },
    ...options
  };
}

describe('K12Info WebSocket handler', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockStoreTicket.mockResolvedValue();
    mockStoreConnection.mockResolvedValue();
    mockSubscribeToSchool.mockResolvedValue();
    mockUnsubscribeFromSchool.mockResolvedValue();
    mockDeleteConnectionState.mockResolvedValue();
  });

  test('creates an authenticated 32-byte base64url ticket', async () => {
    mockVerifyRequiredToken.mockResolvedValue({ sub: 'user-sub' });

    const response = await handler(httpEvent('Bearer access-token'));
    const body = JSON.parse(response.body);

    expect(response.statusCode).toBe(200);
    expect(body.ticket).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(mockStoreTicket).toHaveBeenCalledWith(
      body.ticket,
      'user-sub',
      expect.any(Number)
    );
    const expiresAt = mockStoreTicket.mock.calls[0][2];
    expect(expiresAt).toBeGreaterThanOrEqual(
      Math.floor(Date.now() / 1000) + 59
    );
  });

  test('rejects missing and invalid ticket-endpoint authentication', async () => {
    const missing = await handler(httpEvent());
    mockVerifyRequiredToken.mockRejectedValueOnce(new Error('invalid'));
    const errorSpy = jest.spyOn(console, 'error').mockImplementation();
    const invalid = await handler(httpEvent('Bearer invalid-token'));
    errorSpy.mockRestore();

    expect(missing.statusCode).toBe(401);
    expect(JSON.parse(missing.body)).toEqual({
      error: 'Authorization header required'
    });
    expect(invalid.statusCode).toBe(401);
    expect(JSON.parse(invalid.body)).toEqual({
      error: 'Invalid or expired token'
    });
    expect(mockStoreTicket).not.toHaveBeenCalled();
  });

  test('accepts and stores an anonymous connection', async () => {
    const response = await handler(websocketEvent('$connect'));

    expect(response).toEqual({ statusCode: 200 });
    expect(mockConsumeTicket).not.toHaveBeenCalled();
    expect(mockStoreConnection).toHaveBeenCalledWith(
      'connection-1',
      undefined,
      expect.any(Number),
      expect.any(Number)
    );
  });

  test('consumes a valid ticket and stores an authenticated connection', async () => {
    mockConsumeTicket.mockResolvedValue({ userSub: 'user-sub' });

    const response = await handler(
      websocketEvent('$connect', {
        queryStringParameters: { ticket: 'one-time-ticket' }
      })
    );

    expect(response).toEqual({ statusCode: 200 });
    expect(mockConsumeTicket).toHaveBeenCalledWith(
      'one-time-ticket',
      expect.any(Number)
    );
    expect(mockStoreConnection).toHaveBeenCalledWith(
      'connection-1',
      'user-sub',
      expect.any(Number),
      expect.any(Number)
    );
  });

  test('rejects invalid, expired, and empty supplied tickets', async () => {
    mockConsumeTicket.mockResolvedValue(null);

    const invalid = await handler(
      websocketEvent('$connect', {
        queryStringParameters: { ticket: 'invalid' }
      })
    );
    const empty = await handler(
      websocketEvent('$connect', {
        queryStringParameters: { ticket: '' }
      })
    );

    expect(invalid).toEqual({ statusCode: 401 });
    expect(empty).toEqual({ statusCode: 401 });
    expect(mockStoreConnection).not.toHaveBeenCalled();
  });

  test('rejects reuse after a ticket has been consumed', async () => {
    mockConsumeTicket
      .mockResolvedValueOnce({ userSub: 'user-sub' })
      .mockResolvedValueOnce(null);
    const event = websocketEvent('$connect', {
      queryStringParameters: { ticket: 'single-use' }
    });

    const first = await handler(event);
    const second = await handler(event);

    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(401);
    expect(mockStoreConnection).toHaveBeenCalledTimes(1);
  });

  test('creates an idempotent school subscription', async () => {
    const response = await handler(
      websocketEvent('subscribe-school', {
        body: JSON.stringify({
          action: 'subscribe-school',
          sector: 'public',
          school_id: 'base-school-id'
        })
      })
    );

    expect(response.statusCode).toBe(200);
    expect(mockSubscribeToSchool).toHaveBeenCalledWith(
      'connection-1',
      'public',
      'base-school-id',
      expect.any(Number)
    );
  });

  test('rejects invalid school subscriptions without mutating state', async () => {
    const response = await handler(
      websocketEvent('subscribe-school', {
        body: JSON.stringify({
          action: 'subscribe-school',
          sector: 'invalid',
          school_id: 'base-school-id'
        })
      })
    );

    expect(response.statusCode).toBe(400);
    expect(mockSubscribeToSchool).not.toHaveBeenCalled();
  });

  test('deletes a school subscription idempotently', async () => {
    const response = await handler(
      websocketEvent('unsubscribe-school', {
        body: JSON.stringify({
          action: 'unsubscribe-school',
          sector: 'private',
          school_id: 'base-school-id'
        })
      })
    );

    expect(response.statusCode).toBe(200);
    expect(mockUnsubscribeFromSchool).toHaveBeenCalledWith(
      'connection-1',
      'private',
      'base-school-id'
    );
  });

  test('performs disconnect cleanup as best effort', async () => {
    mockDeleteConnectionState.mockRejectedValue(new Error('cleanup failed'));
    const errorSpy = jest.spyOn(console, 'error').mockImplementation();

    const response = await handler(websocketEvent('$disconnect'));
    errorSpy.mockRestore();

    expect(response.statusCode).toBe(200);
    expect(mockDeleteConnectionState).toHaveBeenCalledWith('connection-1');
  });

  test('$default does not mutate state', async () => {
    const response = await handler(
      websocketEvent('$default', { body: '{not-json' })
    );

    expect(response.statusCode).toBe(200);
    expect(mockStoreConnection).not.toHaveBeenCalled();
    expect(mockSubscribeToSchool).not.toHaveBeenCalled();
    expect(mockUnsubscribeFromSchool).not.toHaveBeenCalled();
  });
});
