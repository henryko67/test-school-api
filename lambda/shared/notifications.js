const {
  ApiGatewayManagementApiClient,
  PostToConnectionCommand
} = require('@aws-sdk/client-apigatewaymanagementapi');
const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const {
  DeleteCommand,
  DynamoDBDocumentClient,
  QueryCommand
} = require('@aws-sdk/lib-dynamodb');
const config = require('../../shared/config');

const websocketEndpoint = process.env.WEBSOCKET_MANAGEMENT_ENDPOINT;
const tableName = config.websocket.tableName;

const documentClient = DynamoDBDocumentClient.from(
  new DynamoDBClient({})
);
const websocketClient = new ApiGatewayManagementApiClient({
  endpoint: websocketEndpoint
});

/**
 * Reads every DynamoDB page for one topic partition.
 *
 * @param {string} topicPk
 * @returns {Promise<object[]>} Subscription rows stored under the topic.
 */
async function getTopicSubscriptions(topicPk) {
  const subscriptions = [];
  let exclusiveStartKey;

  do {
    const result = await documentClient.send(
      new QueryCommand({
        TableName: tableName,
        KeyConditionExpression: 'PK = :pk',
        ExpressionAttributeValues: {
          ':pk': topicPk
        },
        ...(exclusiveStartKey && { ExclusiveStartKey: exclusiveStartKey })
      })
    );

    subscriptions.push(...(result.Items || []));
    exclusiveStartKey = result.LastEvaluatedKey;
  } while (exclusiveStartKey);

  return subscriptions;
}

/**
 * Best-effort deletion of subscription rows associated with a stale connection.
 * Individual DynamoDB failures are logged and do not reject the operation.
 *
 * @param {object[]} subscriptions Rows containing DynamoDB `PK` and `SK` keys.
 * @returns {Promise<void>}
 */
async function removeStaleSubscriptions(subscriptions) {
  const results = await Promise.allSettled(
    subscriptions.map(subscription =>
      documentClient.send(
        new DeleteCommand({
          TableName: tableName,
          Key: {
            PK: subscription.PK,
            SK: subscription.SK
          }
        })
      )
    )
  );

  for (const result of results) {
    if (result.status === 'rejected') {
      console.error(
        'Unable to remove stale WebSocket subscription:',
        result.reason
      );
    }
  }
}

function isGoneConnectionError(error) {
  return (
    error?.name === 'GoneException' ||
    error?.$metadata?.httpStatusCode === 410 ||
    error?.$response?.statusCode === 410 ||
    error?.statusCode === 410 ||
    error?.status === 410
  );
}

/**
 * Collects topic rows by connection so each connection receives one message,
 * even when it is present in multiple requested topics. Topic query failures
 * are logged independently and successful topics are still returned.
 *
 * @param {string[]} topicPks
 * @returns {Promise<Map<string, object[]>>} Connection ID to subscription rows.
 */
async function collectTopicSubscriptions(topicPks) {
  const results = await Promise.allSettled(
    topicPks.map(getTopicSubscriptions)
  );
  // A user's connection may subscribe through both topics; group by connection
  // to deliver one event while retaining every row for stale-state cleanup.
  const subscriptionsByConnection = new Map();

  for (const result of results) {
    if (result.status === 'rejected') {
      console.error(
        'Unable to query WebSocket topic subscriptions:',
        result.reason
      );
      continue;
    }

    for (const subscription of result.value) {
      if (typeof subscription.connectionId !== 'string') {
        continue;
      }

      const existing =
        subscriptionsByConnection.get(subscription.connectionId) || [];
      existing.push(subscription);
      subscriptionsByConnection.set(subscription.connectionId, existing);
    }
  }

  return subscriptionsByConnection;
}

/**
 * Delivers one encoded event and removes all supplied subscription rows when
 * API Gateway reports that the connection is gone. Other failures are logged.
 *
 * @param {string} connectionId
 * @param {object[]} subscriptions
 * @param {Buffer|Uint8Array|string} data
 * @returns {Promise<void>}
 */
async function sendToConnection(connectionId, subscriptions, data) {
  try {
    await websocketClient.send(
      new PostToConnectionCommand({
        ConnectionId: connectionId,
        Data: data
      })
    );
  } catch (error) {
    if (isGoneConnectionError(error)) {
      await removeStaleSubscriptions(subscriptions);
      return;
    }

    console.error('Unable to send WebSocket notification:', error);
  }
}

/**
 * Broadcasts a JSON payload once per distinct connection subscribed to any
 * supplied topic. Query and delivery failures remain best effort.
 *
 * @param {string[]} topicPks
 * @param {object} payload
 * @returns {Promise<void>}
 */
async function broadcastToTopics(topicPks, payload) {
  if (!websocketEndpoint) {
    console.error('WebSocket management endpoint is not configured');
    return;
  }

  const subscriptionsByConnection =
    await collectTopicSubscriptions(topicPks);
  const data = Buffer.from(JSON.stringify(payload));
  const results = await Promise.allSettled(
    [...subscriptionsByConnection.entries()].map(
      ([connectionId, subscriptions]) =>
        sendToConnection(connectionId, subscriptions, data)
    )
  );

  for (const result of results) {
    if (result.status === 'rejected') {
      console.error(
        'Unable to complete WebSocket notification delivery:',
        result.reason
      );
    }
  }
}

/**
 * Publishes a committed comment mutation to its school and author topics.
 * This function never rejects, preserving MongoDB mutation success when
 * realtime infrastructure is unavailable.
 *
 * @param {{event: 'comment-created'|'comment-deleted', commentId: string, sector: 'public'|'private', schoolId: string, authorSub: string}} mutation
 * @returns {Promise<void>}
 */
async function notifyCommentMutation({
  event,
  commentId,
  sector,
  schoolId,
  authorSub
}) {
  try {
    await broadcastToTopics(
      [
        `TOPIC#SCHOOL#${sector}#${schoolId}`,
        `TOPIC#USER#${authorSub}`
      ],
      {
        event,
        data: {
          comment_id: commentId
        }
      }
    );
  } catch (error) {
    // Notifications are best-effort. MongoDB is authoritative, and callers
    // must still return success after an already-committed comment mutation.
    console.error('Unable to broadcast comment mutation:', error);
  }
}

module.exports = {
  notifyCommentMutation
};
