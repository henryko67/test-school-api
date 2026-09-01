const {
  GetParameterCommand,
  SSMClient
} = require('@aws-sdk/client-ssm');
const config = require('./config');

const ssmClient = new SSMClient({});

let mongoDbUriPromise;

function isAwsLambdaRuntime() {
  return Boolean(process.env.AWS_LAMBDA_FUNCTION_NAME);
}

/**
 * Loads the MongoDB URI from local environment configuration or encrypted SSM,
 * depending on whether the process is running in Lambda.
 *
 * @returns {Promise<string|undefined>}
 */
async function loadMongoDbUri() {
  if (!isAwsLambdaRuntime()) {
    return process.env.MONGODB_URI;
  }

  const response = await ssmClient.send(
    new GetParameterCommand({
      Name: config.mongodb.ssmParameterName,
      WithDecryption: true
    })
  );
  const uri = response.Parameter?.Value;

  if (!uri) {
    throw new Error('MongoDB URI parameter has no value');
  }

  return uri;
}

/**
 * Returns a module-cached URI promise. Failed SSM reads clear the cache so a
 * later warm invocation can retry.
 *
 * @returns {Promise<string|undefined>}
 */
function getMongoDbUri() {
  if (!mongoDbUriPromise) {
    mongoDbUriPromise = loadMongoDbUri().catch(error => {
      // Permit a later invocation to recover from a transient SSM failure.
      mongoDbUriPromise = null;
      throw error;
    });
  }

  return mongoDbUriPromise;
}

module.exports = {
  getMongoDbUri,
  isAwsLambdaRuntime
};
