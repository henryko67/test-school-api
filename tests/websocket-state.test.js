const mockSend = jest.fn();
const mockDocumentClientFrom = jest.fn(() => ({ send: mockSend }));

jest.mock('@aws-sdk/client-dynamodb', () => ({
  DynamoDBClient: jest.fn()
}));

jest.mock('@aws-sdk/lib-dynamodb', () => {
  class DeleteCommand {
    constructor(input) {
      this.input = input;
    }
  }

  class PutCommand {
    constructor(input) {
      this.input = input;
    }
  }

  class QueryCommand {
    constructor(input) {
      this.input = input;
    }
  }

  class TransactWriteCommand {
    constructor(input) {
      this.input = input;
    }
  }

  return {
    DeleteCommand,
    DynamoDBDocumentClient: { from: mockDocumentClientFrom },
    PutCommand,
    QueryCommand,
    TransactWriteCommand
  };
});

const {
  consumeTicket,
  deleteConnectionState,
  storeConnection,
  storeTicket,
  subscribeToSchool,
  unsubscribeFromSchool
} = require('../lambda/websocket/state');

describe('WebSocket DynamoDB state', () => {
  beforeEach(() => {
    mockSend.mockReset();
  });

  test('stores ticket metadata with a Unix-seconds expiry', async () => {
    mockSend.mockResolvedValue({});

    await storeTicket('ticket', 'user-sub', 1060);

    expect(mockSend.mock.calls[0][0].input).toEqual({
      TableName: 'K12InfoWebSocketState',
      Item: {
        PK: 'TICKET#ticket',
        SK: 'META',
        userSub: 'user-sub',
        expiresAt: 1060
      }
    });
  });

  test('atomically consumes tickets and rejects expired records', async () => {
    mockSend
      .mockResolvedValueOnce({
        Attributes: { userSub: 'user-sub', expiresAt: 1060 }
      })
      .mockResolvedValueOnce({
        Attributes: { userSub: 'user-sub', expiresAt: 999 }
      })
      .mockResolvedValueOnce({});

    await expect(consumeTicket('ticket', 1000)).resolves.toEqual({
      userSub: 'user-sub',
      expiresAt: 1060
    });
    await expect(consumeTicket('expired', 1000)).resolves.toBeNull();
    await expect(consumeTicket('consumed', 1000)).resolves.toBeNull();

    expect(mockSend.mock.calls[0][0].input).toEqual({
      TableName: 'K12InfoWebSocketState',
      Key: { PK: 'TICKET#ticket', SK: 'META' },
      ReturnValues: 'ALL_OLD'
    });
  });

  test('stores authenticated connection metadata and user subscription atomically', async () => {
    mockSend.mockResolvedValue({});

    await storeConnection('connection-1', 'user-sub', 1000, 11800);

    const transaction = mockSend.mock.calls[0][0].input.TransactItems;
    expect(transaction).toHaveLength(2);
    expect(transaction[0].Put.Item).toEqual({
      PK: 'CONNECTION#connection-1',
      SK: 'META',
      connectionId: 'connection-1',
      connectedAt: 1000,
      expiresAt: 11800,
      userSub: 'user-sub'
    });
    expect(transaction[1].Put.Item).toEqual({
      PK: 'TOPIC#USER#user-sub',
      SK: 'CONNECTION#connection-1',
      connectionId: 'connection-1',
      userSub: 'user-sub',
      GSI1PK: 'CONNECTION#connection-1',
      GSI1SK: 'TOPIC#USER#user-sub',
      expiresAt: 11800
    });
  });

  test('stores and removes the expected school subscription key', async () => {
    mockSend.mockResolvedValue({});

    await subscribeToSchool(
      'connection-1',
      'public',
      'base-school-id',
      11800
    );
    await unsubscribeFromSchool(
      'connection-1',
      'public',
      'base-school-id'
    );

    expect(mockSend.mock.calls[0][0].input.Item).toEqual({
      PK: 'TOPIC#SCHOOL#public#base-school-id',
      SK: 'CONNECTION#connection-1',
      connectionId: 'connection-1',
      GSI1PK: 'CONNECTION#connection-1',
      GSI1SK: 'TOPIC#SCHOOL#public#base-school-id',
      expiresAt: 11800
    });
    expect(mockSend.mock.calls[1][0].input.Key).toEqual({
      PK: 'TOPIC#SCHOOL#public#base-school-id',
      SK: 'CONNECTION#connection-1'
    });
  });

  test('queries GSI1 and deletes subscriptions plus connection metadata', async () => {
    mockSend.mockImplementation(command => {
      if (command.input.IndexName === 'GSI1') {
        return Promise.resolve({
          Items: [
            {
              PK: 'TOPIC#USER#user-sub',
              SK: 'CONNECTION#connection-1'
            },
            {
              PK: 'TOPIC#SCHOOL#public#school-id',
              SK: 'CONNECTION#connection-1'
            }
          ]
        });
      }

      return Promise.resolve({});
    });

    await deleteConnectionState('connection-1');

    expect(mockSend.mock.calls[0][0].input).toMatchObject({
      TableName: 'K12InfoWebSocketState',
      IndexName: 'GSI1',
      KeyConditionExpression: 'GSI1PK = :connectionKey',
      ExpressionAttributeValues: {
        ':connectionKey': 'CONNECTION#connection-1'
      }
    });
    const deletedKeys = mockSend.mock.calls
      .slice(1)
      .map(([command]) => command.input.Key);
    expect(deletedKeys).toEqual(
      expect.arrayContaining([
        {
          PK: 'TOPIC#USER#user-sub',
          SK: 'CONNECTION#connection-1'
        },
        {
          PK: 'TOPIC#SCHOOL#public#school-id',
          SK: 'CONNECTION#connection-1'
        },
        {
          PK: 'CONNECTION#connection-1',
          SK: 'META'
        }
      ])
    );
  });
});
