const mockConnectDatabase = jest.fn();
const mockGetOptionalUser = jest.fn();
const mockRequireAuthenticatedUser = jest.fn();
const mockNotifyCommentMutation = jest.fn();

jest.mock('../shared/mongodb', () => ({
  connectDatabase: mockConnectDatabase
}));

jest.mock('../lambda/shared/auth', () => ({
  getOptionalUser: mockGetOptionalUser,
  requireAuthenticatedUser: mockRequireAuthenticatedUser
}));

jest.mock('../lambda/shared/notifications', () => ({
  notifyCommentMutation: mockNotifyCommentMutation
}));

const {
  createComment,
  deleteComment,
  getCurrentUserComments,
  getSchoolComments
} = require('../lambda/comments/handler');

describe('comment mutation profile authorization', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockRequireAuthenticatedUser.mockResolvedValue({
      user: { sub: 'deleted-cognito-user' }
    });
    mockGetOptionalUser.mockResolvedValue(null);
  });

  test('keeps public school comment reads anonymous', async () => {
    const aggregate = jest.fn().mockReturnValue({
      toArray: jest.fn().mockResolvedValue([])
    });
    mockConnectDatabase.mockResolvedValue({
      publicSchools: {
        findOne: jest.fn().mockResolvedValue({ _id: '5301138' })
      },
      privateSchools: {
        findOne: jest.fn()
      },
      comments: { aggregate }
    });

    const response = await getSchoolComments({
      pathParameters: { sector: 'public', id: '5301138' },
      query: {}
    });

    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body)).toEqual({
      comments: [],
      hasMore: false,
      nextCursor: null
    });
    expect(mockRequireAuthenticatedUser).not.toHaveBeenCalled();
    expect(mockGetOptionalUser).toHaveBeenCalledTimes(1);
  });

  test('keeps authenticated current-user comment reads working', async () => {
    mockRequireAuthenticatedUser.mockResolvedValue({
      user: { sub: 'active-cognito-user' }
    });
    const toArray = jest.fn().mockResolvedValue([]);
    const limit = jest.fn().mockReturnValue({ toArray });
    const sort = jest.fn().mockReturnValue({ limit });
    const find = jest.fn().mockReturnValue({ sort });
    mockConnectDatabase.mockResolvedValue({
      comments: { find },
      publicSchools: {},
      privateSchools: {}
    });

    const response = await getCurrentUserComments({
      authorization: 'Bearer valid-token',
      query: {}
    });

    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body)).toEqual({
      comments: [],
      hasMore: false,
      nextCursor: null
    });
    expect(find).toHaveBeenCalledWith({
      author_sub: 'active-cognito-user'
    });
  });

  test('rejects comment creation when a valid JWT has no Mongo user profile', async () => {
    const insertOne = jest.fn();
    const collections = {
      publicSchools: {
        findOne: jest.fn().mockResolvedValue({ _id: 'school-id' })
      },
      privateSchools: {
        findOne: jest.fn()
      },
      users: {
        findOne: jest.fn().mockResolvedValue(null)
      },
      comments: { insertOne }
    };
    mockConnectDatabase.mockResolvedValue(collections);

    const response = await createComment({
      authorization: 'Bearer still-valid-token',
      pathParameters: { sector: 'public', id: 'school-id' },
      body: { text: 'This must not be created' }
    });

    expect(response.statusCode).toBe(403);
    expect(JSON.parse(response.body)).toEqual({
      error: 'User profile no longer exists'
    });
    expect(collections.users.findOne).toHaveBeenCalledWith(
      { cognito_sub: 'deleted-cognito-user' },
      { projection: { username: 1 } }
    );
    expect(insertOne).not.toHaveBeenCalled();
    expect(mockNotifyCommentMutation).not.toHaveBeenCalled();
  });

  test('rejects comment deletion when a valid JWT has no Mongo user profile', async () => {
    const findOneAndDelete = jest.fn();
    const collections = {
      users: {
        findOne: jest.fn().mockResolvedValue(null)
      },
      comments: { findOneAndDelete }
    };
    mockConnectDatabase.mockResolvedValue(collections);

    const response = await deleteComment({
      authorization: 'Bearer still-valid-token',
      pathParameters: { id: '507f1f77bcf86cd799439011' }
    });

    expect(response.statusCode).toBe(403);
    expect(JSON.parse(response.body)).toEqual({
      error: 'User profile no longer exists'
    });
    expect(collections.users.findOne).toHaveBeenCalledWith(
      { cognito_sub: 'deleted-cognito-user' },
      { projection: { username: 1 } }
    );
    expect(findOneAndDelete).not.toHaveBeenCalled();
    expect(mockNotifyCommentMutation).not.toHaveBeenCalled();
  });
});
