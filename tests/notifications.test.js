const mockDynamoSend = jest.fn();
const mockWebSocketSend = jest.fn();

process.env.WEBSOCKET_MANAGEMENT_ENDPOINT =
  'https://example.execute-api.us-west-2.amazonaws.com/prod';
process.env.WEBSOCKET_STATE_TABLE = 'K12InfoWebSocketState';

jest.mock('@aws-sdk/client-apigatewaymanagementapi', () => {
  class PostToConnectionCommand {
    constructor(input) {
      this.input = input;
    }
  }

  return {
    ApiGatewayManagementApiClient: jest.fn(() => ({
      send: mockWebSocketSend
    })),
    PostToConnectionCommand
  };
});

jest.mock('@aws-sdk/client-dynamodb', () => ({
  DynamoDBClient: jest.fn()
}));

jest.mock('@aws-sdk/lib-dynamodb', () => {
  class DeleteCommand {
    constructor(input) {
      this.input = input;
      this.type = 'delete';
    }
  }

  class QueryCommand {
    constructor(input) {
      this.input = input;
      this.type = 'query';
    }
  }

  return {
    DeleteCommand,
    DynamoDBDocumentClient: {
      from: jest.fn(() => ({ send: mockDynamoSend }))
    },
    QueryCommand
  };
});

const {
  notifyCommentMutation
} = require('../lambda/shared/notifications');

function subscription(topic, connectionId) {
  return {
    PK: topic,
    SK: `CONNECTION#${connectionId}`,
    connectionId
  };
}

function queryItemsByTopic(itemsByTopic) {
  mockDynamoSend.mockImplementation(command => {
    if (command.type === 'delete') {
      return Promise.resolve({});
    }

    const topic = command.input.ExpressionAttributeValues[':pk'];
    return Promise.resolve({ Items: itemsByTopic[topic] || [] });
  });
}

function sentMessages() {
  return mockWebSocketSend.mock.calls.map(([command]) => ({
    connectionId: command.input.ConnectionId,
    payload: JSON.parse(Buffer.from(command.input.Data).toString('utf8'))
  }));
}

describe('WebSocket comment notifications', () => {
  beforeEach(() => {
    mockDynamoSend.mockReset();
    mockWebSocketSend.mockReset();
    mockWebSocketSend.mockResolvedValue({});
  });

  test('broadcasts to school-topic subscriptions', async () => {
    queryItemsByTopic({
      'TOPIC#SCHOOL#public#school-1': [
        subscription('TOPIC#SCHOOL#public#school-1', 'school-viewer')
      ]
    });

    await notifyCommentMutation({
      event: 'comment-created',
      commentId: 'comment-1',
      sector: 'public',
      schoolId: 'school-1',
      authorSub: 'author-1'
    });

    expect(sentMessages()).toContainEqual({
      connectionId: 'school-viewer',
      payload: {
        event: 'comment-created',
        data: { comment_id: 'comment-1' }
      }
    });
  });

  test('broadcasts to user-topic subscriptions', async () => {
    queryItemsByTopic({
      'TOPIC#USER#author-1': [
        subscription('TOPIC#USER#author-1', 'settings-viewer')
      ]
    });

    await notifyCommentMutation({
      event: 'comment-deleted',
      commentId: 'comment-2',
      sector: 'private',
      schoolId: 'school-2',
      authorSub: 'author-1'
    });

    expect(sentMessages()).toContainEqual({
      connectionId: 'settings-viewer',
      payload: {
        event: 'comment-deleted',
        data: { comment_id: 'comment-2' }
      }
    });
  });

  test.each([
    ['comment-created', 'created-id'],
    ['comment-deleted', 'deleted-id']
  ])('sends the correct %s payload', async (event, commentId) => {
    queryItemsByTopic({
      'TOPIC#SCHOOL#public#school-1': [
        subscription('TOPIC#SCHOOL#public#school-1', 'connection-1')
      ]
    });

    await notifyCommentMutation({
      event,
      commentId,
      sector: 'public',
      schoolId: 'school-1',
      authorSub: 'author-1'
    });

    expect(sentMessages()[0].payload).toEqual({
      event,
      data: { comment_id: commentId }
    });
  });

  test('reads every page of DynamoDB Query results', async () => {
    mockDynamoSend.mockImplementation(command => {
      if (command.type === 'delete') {
        return Promise.resolve({});
      }

      const topic = command.input.ExpressionAttributeValues[':pk'];

      if (topic === 'TOPIC#USER#author-1') {
        return Promise.resolve({ Items: [] });
      }

      if (!command.input.ExclusiveStartKey) {
        return Promise.resolve({
          Items: [
            subscription(topic, 'page-1')
          ],
          LastEvaluatedKey: { PK: topic, SK: 'CONNECTION#page-1' }
        });
      }

      return Promise.resolve({
        Items: [subscription(topic, 'page-2')]
      });
    });

    await notifyCommentMutation({
      event: 'comment-created',
      commentId: 'comment-1',
      sector: 'public',
      schoolId: 'school-1',
      authorSub: 'author-1'
    });

    expect(sentMessages().map(message => message.connectionId).sort()).toEqual([
      'page-1',
      'page-2'
    ]);
    const schoolQueries = mockDynamoSend.mock.calls
      .map(([command]) => command)
      .filter(command =>
        command.type === 'query' &&
        command.input.ExpressionAttributeValues[':pk'] ===
          'TOPIC#SCHOOL#public#school-1'
      );
    expect(schoolQueries).toHaveLength(2);
    expect(schoolQueries[1].input.ExclusiveStartKey).toEqual({
      PK: 'TOPIC#SCHOOL#public#school-1',
      SK: 'CONNECTION#page-1'
    });
  });

  test.each([
    [{ name: 'GoneException' }],
    [{ $metadata: { httpStatusCode: 410 } }]
  ])('removes stale subscriptions after a gone connection', async error => {
    const schoolSubscription = subscription(
      'TOPIC#SCHOOL#public#school-1',
      'stale-connection'
    );
    const userSubscription = subscription(
      'TOPIC#USER#author-1',
      'stale-connection'
    );
    queryItemsByTopic({
      'TOPIC#SCHOOL#public#school-1': [schoolSubscription],
      'TOPIC#USER#author-1': [userSubscription]
    });
    mockWebSocketSend.mockRejectedValue(error);

    await expect(
      notifyCommentMutation({
        event: 'comment-created',
        commentId: 'comment-1',
        sector: 'public',
        schoolId: 'school-1',
        authorSub: 'author-1'
      })
    ).resolves.toBeUndefined();

    const deletedKeys = mockDynamoSend.mock.calls
      .map(([command]) => command)
      .filter(command => command.type === 'delete')
      .map(command => command.input.Key);
    expect(deletedKeys).toEqual(
      expect.arrayContaining([
        { PK: schoolSubscription.PK, SK: schoolSubscription.SK },
        { PK: userSubscription.PK, SK: userSubscription.SK }
      ])
    );
    expect(mockWebSocketSend).toHaveBeenCalledTimes(1);
  });

  test('logs non-410 delivery failures without deleting subscriptions', async () => {
    queryItemsByTopic({
      'TOPIC#SCHOOL#public#school-1': [
        subscription('TOPIC#SCHOOL#public#school-1', 'connection-1')
      ]
    });
    mockWebSocketSend.mockRejectedValue(new Error('delivery unavailable'));
    const errorSpy = jest.spyOn(console, 'error').mockImplementation();

    await expect(
      notifyCommentMutation({
        event: 'comment-created',
        commentId: 'comment-1',
        sector: 'public',
        schoolId: 'school-1',
        authorSub: 'author-1'
      })
    ).resolves.toBeUndefined();

    expect(errorSpy).toHaveBeenCalledWith(
      'Unable to send WebSocket notification:',
      expect.any(Error)
    );
    expect(
      mockDynamoSend.mock.calls.some(([command]) => command.type === 'delete')
    ).toBe(false);
    errorSpy.mockRestore();
  });

  test('never propagates notification failures into mutation flow', async () => {
    mockDynamoSend.mockRejectedValue(new Error('DynamoDB unavailable'));
    const errorSpy = jest.spyOn(console, 'error').mockImplementation();

    const mutationFlow = async () => {
      const persistedComment = { _id: 'already-committed' };

      await notifyCommentMutation({
        event: 'comment-created',
        commentId: persistedComment._id,
        sector: 'public',
        schoolId: 'school-1',
        authorSub: 'author-1'
      });

      return persistedComment;
    };

    await expect(mutationFlow()).resolves.toEqual({
      _id: 'already-committed'
    });
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });
});
