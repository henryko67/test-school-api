const { MongoClient } = require('mongodb');
const config = require('./config');
const { getMongoDbUri } = require('./mongodb-uri');

let client;
let clientPromise;
let connectionPromise;
let collections;

// These module-scoped values survive warm Lambda invocations. Promise caching
// also makes concurrent cold-start requests share one client/connection attempt.
/**
 * Returns the process-wide Mongo client, resolving its URI from local
 * configuration or SSM on first use.
 *
 * @returns {Promise<import('mongodb').MongoClient>}
 */
async function getClient() {
  if (!clientPromise) {
    clientPromise = getMongoDbUri()
      .then(uri => {
        client = new MongoClient(uri);
        return client;
      })
      .catch(error => {
        clientPromise = null;
        throw error;
      });
  }

  return clientPromise;
}

/**
 * Connects once per Lambda execution environment and returns named collection
 * handles shared by all route groups.
 *
 * @returns {Promise<Record<string, import('mongodb').Collection>>}
 */
async function connectDatabase() {
  if (!connectionPromise) {
    connectionPromise = (async () => {
      const mongoClient = await getClient();
      await mongoClient.connect();
      return mongoClient;
    })().catch(error => {
      connectionPromise = null;
      throw error;
    });
  }

  const mongoClient = await connectionPromise;

  if (!collections) {
    const db = mongoClient.db(config.mongodb.databaseName);
    const names = config.mongodb.collections;

    collections = {
      privateSchools: db.collection(names.privateSchools),
      publicSchools: db.collection(names.publicSchools),
      locations: db.collection(names.locations),
      users: db.collection(names.users),
      comments: db.collection(names.comments),
      teachersStaff: db.collection(names.teachersStaff),
      discipline: db.collection(names.discipline)
    };
  }

  return collections;
}

/**
 * Returns initialized collection handles without starting a connection.
 *
 * @returns {Record<string, import('mongodb').Collection>}
 * @throws {Error} When `connectDatabase` has not completed.
 */
function getCollections() {
  if (!collections) {
    throw new Error('Database has not been connected');
  }

  return collections;
}

/**
 * Closes the cached client and clears module state, primarily for tests and
 * controlled local shutdown.
 *
 * @returns {Promise<void>}
 */
async function disconnectDatabase() {
  if (!client) {
    return;
  }

  await client.close();
  client = null;
  clientPromise = null;
  connectionPromise = null;
  collections = null;
}

module.exports = {
  connectDatabase,
  disconnectDatabase,
  getClient,
  getCollections
};
