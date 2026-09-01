const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const {
  DeleteCommand,
  DynamoDBDocumentClient,
  PutCommand,
  QueryCommand,
  TransactWriteCommand
} = require('@aws-sdk/lib-dynamodb');
const config = require('../../shared/config');

const documentClient = DynamoDBDocumentClient.from(
  new DynamoDBClient({})
);

const tableName = config.websocket.tableName;

function connectionKey(connectionId) {
  return `CONNECTION#${connectionId}`;
}

function schoolTopicKey(sector, schoolId) {
  return `TOPIC#SCHOOL#${sector}#${schoolId}`;
}

function userTopicKey(userSub) {
  return `TOPIC#USER#${userSub}`;
}

/**
 * Stores a short-lived WebSocket authentication ticket.
 *
 * @param {string} ticket
 * @param {string} userSub Verified Cognito subject.
 * @param {number} expiresAt Unix epoch seconds.
 * @returns {Promise<void>}
 */
async function storeTicket(ticket, userSub, expiresAt) {
  await documentClient.send(
    new PutCommand({
      TableName: tableName,
      Item: {
        PK: `TICKET#${ticket}`,
        SK: 'META',
        userSub,
        expiresAt
      }
    })
  );
}

/**
 * Atomically deletes and returns a ticket, enforcing single use even across
 * concurrent Lambda instances.
 *
 * @param {string} ticket
 * @param {number} now Current Unix epoch seconds.
 * @returns {Promise<{userSub: string, expiresAt: number}|null>}
 */
async function consumeTicket(ticket, now) {
  // Delete-with-return is the single-use boundary: concurrent connects cannot
  // both authenticate with the same short-lived ticket.
  const result = await documentClient.send(
    new DeleteCommand({
      TableName: tableName,
      Key: {
        PK: `TICKET#${ticket}`,
        SK: 'META'
      },
      ReturnValues: 'ALL_OLD'
    })
  );
  const ticketRecord = result.Attributes;

  if (
    !ticketRecord ||
    typeof ticketRecord.userSub !== 'string' ||
    ticketRecord.expiresAt <= now
  ) {
    return null;
  }

  return ticketRecord;
}

/**
 * Stores connection metadata and, for authenticated connections, atomically
 * creates the private user-topic subscription.
 *
 * @param {string} connectionId
 * @param {string|undefined} userSub
 * @param {number} connectedAt Unix epoch seconds.
 * @param {number} expiresAt Unix epoch seconds.
 * @returns {Promise<void>}
 */
async function storeConnection(
  connectionId,
  userSub,
  connectedAt,
  expiresAt
) {
  const metadata = {
    PK: connectionKey(connectionId),
    SK: 'META',
    connectionId,
    connectedAt,
    expiresAt,
    ...(userSub && { userSub })
  };

  if (!userSub) {
    await documentClient.send(
      new PutCommand({
        TableName: tableName,
        Item: metadata
      })
    );
    return;
  }

  const topicKey = userTopicKey(userSub);

  // Authenticated connections and their private user-topic subscription are
  // created atomically so a successful connect cannot leave partial state.
  await documentClient.send(
    new TransactWriteCommand({
      TransactItems: [
        {
          Put: {
            TableName: tableName,
            Item: metadata
          }
        },
        {
          Put: {
            TableName: tableName,
            Item: {
              PK: topicKey,
              SK: connectionKey(connectionId),
              connectionId,
              userSub,
              GSI1PK: connectionKey(connectionId),
              GSI1SK: topicKey,
              expiresAt
            }
          }
        }
      ]
    })
  );
}

/**
 * Idempotently stores a school-topic subscription for a connection.
 *
 * @param {string} connectionId
 * @param {'public'|'private'} sector
 * @param {string} schoolId Base school document `_id`.
 * @param {number} expiresAt Unix epoch seconds.
 * @returns {Promise<void>}
 */
async function subscribeToSchool(
  connectionId,
  sector,
  schoolId,
  expiresAt
) {
  const topicKey = schoolTopicKey(sector, schoolId);

  await documentClient.send(
    new PutCommand({
      TableName: tableName,
      Item: {
        PK: topicKey,
        SK: connectionKey(connectionId),
        connectionId,
        GSI1PK: connectionKey(connectionId),
        GSI1SK: topicKey,
        expiresAt
      }
    })
  );
}

/**
 * Idempotently removes a school-topic subscription.
 *
 * @param {string} connectionId
 * @param {'public'|'private'} sector
 * @param {string} schoolId
 * @returns {Promise<void>}
 */
async function unsubscribeFromSchool(connectionId, sector, schoolId) {
  await documentClient.send(
    new DeleteCommand({
      TableName: tableName,
      Key: {
        PK: schoolTopicKey(sector, schoolId),
        SK: connectionKey(connectionId)
      }
    })
  );
}

/**
 * Reads every reverse-index page of subscriptions owned by a connection.
 *
 * @param {string} connectionId
 * @returns {Promise<object[]>}
 */
async function findConnectionSubscriptions(connectionId) {
  const subscriptions = [];
  let exclusiveStartKey;

  do {
    // GSI1 is the reverse lookup used to remove all topic rows on disconnect.
    const result = await documentClient.send(
      new QueryCommand({
        TableName: tableName,
        IndexName: 'GSI1',
        KeyConditionExpression: 'GSI1PK = :connectionKey',
        ExpressionAttributeValues: {
          ':connectionKey': connectionKey(connectionId)
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
 * Deletes all indexed topic subscriptions and connection metadata.
 * Callers treat this cleanup as best effort because `$disconnect` delivery is
 * not guaranteed by API Gateway.
 *
 * @param {string} connectionId
 * @returns {Promise<void>}
 */
async function deleteConnectionState(connectionId) {
  const subscriptions = await findConnectionSubscriptions(connectionId);

  await Promise.all(
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

  await documentClient.send(
    new DeleteCommand({
      TableName: tableName,
      Key: {
        PK: connectionKey(connectionId),
        SK: 'META'
      }
    })
  );
}

module.exports = {
  consumeTicket,
  deleteConnectionState,
  storeConnection,
  storeTicket,
  subscribeToSchool,
  unsubscribeFromSchool
};
