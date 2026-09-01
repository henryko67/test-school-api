const mockSend = jest.fn();
const mockGetParameterCommand = jest.fn(function GetParameterCommand(input) {
  this.input = input;
});
const mockSsmClient = jest.fn(() => ({ send: mockSend }));

jest.mock('@aws-sdk/client-ssm', () => ({
  GetParameterCommand: mockGetParameterCommand,
  SSMClient: mockSsmClient
}));

describe('MongoDB URI resolution', () => {
  const originalLambdaName = process.env.AWS_LAMBDA_FUNCTION_NAME;
  const originalMongoDbUri = process.env.MONGODB_URI;

  beforeEach(() => {
    jest.resetModules();
    mockSend.mockReset();
    mockGetParameterCommand.mockClear();
    mockSsmClient.mockClear();
    delete process.env.AWS_LAMBDA_FUNCTION_NAME;
    delete process.env.MONGODB_URI;
  });

  afterAll(() => {
    if (originalLambdaName === undefined) {
      delete process.env.AWS_LAMBDA_FUNCTION_NAME;
    } else {
      process.env.AWS_LAMBDA_FUNCTION_NAME = originalLambdaName;
    }

    if (originalMongoDbUri === undefined) {
      delete process.env.MONGODB_URI;
    } else {
      process.env.MONGODB_URI = originalMongoDbUri;
    }
  });

  test('uses MONGODB_URI locally without querying SSM', async () => {
    process.env.MONGODB_URI = 'mongodb://local-test';
    const { getMongoDbUri } = require('../shared/mongodb-uri');

    await expect(getMongoDbUri()).resolves.toBe('mongodb://local-test');
    expect(mockSend).not.toHaveBeenCalled();
  });

  test('retrieves and decrypts the production parameter in Lambda', async () => {
    process.env.AWS_LAMBDA_FUNCTION_NAME = 'k12info-comments';
    process.env.MONGODB_URI = 'mongodb://must-not-be-used';
    mockSend.mockResolvedValue({
      Parameter: { Value: 'mongodb://from-ssm' }
    });
    const { getMongoDbUri } = require('../shared/mongodb-uri');

    await expect(getMongoDbUri()).resolves.toBe('mongodb://from-ssm');
    expect(mockGetParameterCommand).toHaveBeenCalledWith({
      Name: '/k12info/prod/mongodb-uri',
      WithDecryption: true
    });
    expect(mockSend).toHaveBeenCalledTimes(1);
  });

  test('caches the resolved URI promise across warm invocations', async () => {
    process.env.AWS_LAMBDA_FUNCTION_NAME = 'k12info-schools';
    mockSend.mockResolvedValue({
      Parameter: { Value: 'mongodb://cached' }
    });
    const { getMongoDbUri } = require('../shared/mongodb-uri');

    const [first, second, third] = await Promise.all([
      getMongoDbUri(),
      getMongoDbUri(),
      getMongoDbUri()
    ]);

    expect([first, second, third]).toEqual([
      'mongodb://cached',
      'mongodb://cached',
      'mongodb://cached'
    ]);
    expect(mockSend).toHaveBeenCalledTimes(1);

    await expect(getMongoDbUri()).resolves.toBe('mongodb://cached');
    expect(mockSend).toHaveBeenCalledTimes(1);
  });

  test('propagates SSM failures without falling back and permits retry', async () => {
    process.env.AWS_LAMBDA_FUNCTION_NAME = 'k12info-users';
    process.env.MONGODB_URI = 'mongodb://must-not-be-used';
    const ssmError = new Error('SSM unavailable');
    mockSend
      .mockRejectedValueOnce(ssmError)
      .mockResolvedValueOnce({
        Parameter: { Value: 'mongodb://recovered' }
      });
    const { getMongoDbUri } = require('../shared/mongodb-uri');

    await expect(getMongoDbUri()).rejects.toBe(ssmError);
    await expect(getMongoDbUri()).resolves.toBe('mongodb://recovered');
    expect(mockSend).toHaveBeenCalledTimes(2);
  });

  test('rejects an empty Parameter Store response', async () => {
    process.env.AWS_LAMBDA_FUNCTION_NAME = 'k12info-search';
    mockSend.mockResolvedValue({ Parameter: {} });
    const { getMongoDbUri } = require('../shared/mongodb-uri');

    await expect(getMongoDbUri()).rejects.toThrow(
      'MongoDB URI parameter has no value'
    );
  });
});
