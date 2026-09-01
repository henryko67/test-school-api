const mockConnectDatabase = jest.fn();

jest.mock('../shared/mongodb', () => ({
  connectDatabase: mockConnectDatabase
}));

const {
  locationSchools,
  search
} = require('../lambda/search/handler');

function aggregateCollection(results) {
  return {
    aggregate: jest.fn().mockReturnValue({
      toArray: jest.fn().mockResolvedValue(results)
    })
  };
}

function searchCollections({
  publicResults = [],
  privateResults = [],
  locationResults = []
} = {}) {
  return {
    publicSchools: aggregateCollection(publicResults),
    privateSchools: aggregateCollection(privateResults),
    locations: aggregateCollection(locationResults)
  };
}

function responseBody(response) {
  return JSON.parse(response.body);
}

describe('Search Lambda behavior', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('rejects a pagination type when after is missing or empty', async () => {
    const missing = await search({
      query: { q: 'Seattle', type: 'location' }
    });
    const empty = await search({
      query: { q: 'Seattle', type: 'location', after: '' }
    });

    for (const response of [missing, empty]) {
      expect(response.statusCode).toBe(400);
      expect(responseBody(response)).toEqual({
        error: 'Pagination requires both type and after'
      });
    }
    expect(mockConnectDatabase).not.toHaveBeenCalled();
  });

  test('rejects an after token without a pagination type', async () => {
    const response = await search({
      query: { q: 'Seattle', after: 'location-token' }
    });

    expect(response.statusCode).toBe(400);
    expect(responseBody(response)).toEqual({
      error: 'Pagination requires both type and after'
    });
    expect(mockConnectDatabase).not.toHaveBeenCalled();
  });

  test('rejects an unsupported pagination type', async () => {
    const response = await search({
      query: { q: 'Seattle', type: 'district', after: 'token' }
    });

    expect(response.statusCode).toBe(400);
    expect(responseBody(response)).toEqual({
      error: 'Invalid search type'
    });
    expect(mockConnectDatabase).not.toHaveBeenCalled();
  });

  test('returns a matching Seattle location in initial search results', async () => {
    const collections = searchCollections({
      locationResults: [
        {
          _id: 'city:WA:seattle',
          type: 'city',
          label: 'Seattle, WA',
          paginationToken: 'seattle-token',
          score: 10
        }
      ]
    });
    mockConnectDatabase.mockResolvedValue(collections);

    const response = await search({ query: { q: 'Seattle' } });

    expect(response.statusCode).toBe(200);
    expect(responseBody(response).locations).toEqual([
      expect.objectContaining({
        _id: 'city:WA:seattle',
        label: 'Seattle, WA'
      })
    ]);
    const pipeline = collections.locations.aggregate.mock.calls[0][0];
    expect(pipeline[0].$search.searchAfter).toBeUndefined();
  });

  test('returns a terminal empty location page with locationHasMore false', async () => {
    const collections = searchCollections();
    mockConnectDatabase.mockResolvedValue(collections);

    const response = await search({
      query: {
        q: 'Seattle',
        type: 'location',
        after: 'last-location-token'
      }
    });

    expect(response.statusCode).toBe(200);
    expect(responseBody(response)).toEqual({
      locations: [],
      pagination: { locationHasMore: false }
    });
  });

  test('continues location pagination using the Atlas token', async () => {
    const locationResults = Array.from({ length: 6 }, (_, index) => ({
      _id: `city:OR:portland-${index + 1}`,
      paginationToken: `location-token-${index + 1}`
    }));
    const collections = searchCollections({ locationResults });
    mockConnectDatabase.mockResolvedValue(collections);

    const response = await search({
      query: {
        q: 'Portland',
        type: 'location',
        after: 'previous-location-token'
      }
    });
    const body = responseBody(response);

    expect(response.statusCode).toBe(200);
    expect(body.locations).toHaveLength(5);
    expect(body.pagination).toEqual({
      locationAfter: 'location-token-5',
      locationHasMore: true
    });
    const pipeline = collections.locations.aggregate.mock.calls[0][0];
    expect(pipeline[0].$search.searchAfter).toBe(
      'previous-location-token'
    );
  });

  test('continues public-school pagination using the Atlas token', async () => {
    const publicResults = Array.from({ length: 11 }, (_, index) => ({
      _id: `public-${index + 1}`,
      paginationToken: `public-token-${index + 1}`
    }));
    const collections = searchCollections({ publicResults });
    mockConnectDatabase.mockResolvedValue(collections);

    const response = await search({
      query: {
        q: 'Portland',
        type: 'public',
        after: 'previous-public-token'
      }
    });
    const body = responseBody(response);

    expect(response.statusCode).toBe(200);
    expect(body.schools).toHaveLength(10);
    expect(body.schools.every(school => school.sector === 'public')).toBe(true);
    expect(body.pagination).toEqual({
      publicAfter: 'public-token-10',
      publicHasMore: true
    });
    const pipeline = collections.publicSchools.aggregate.mock.calls[0][0];
    expect(pipeline[0].$search.searchAfter).toBe('previous-public-token');
  });

  test('continues private-school pagination using the Atlas token', async () => {
    const privateResults = Array.from({ length: 11 }, (_, index) => ({
      _id: `private-${index + 1}`,
      paginationToken: `private-token-${index + 1}`
    }));
    const collections = searchCollections({ privateResults });
    mockConnectDatabase.mockResolvedValue(collections);

    const response = await search({
      query: {
        q: 'Portland',
        type: 'private',
        after: 'previous-private-token'
      }
    });
    const body = responseBody(response);

    expect(response.statusCode).toBe(200);
    expect(body.schools).toHaveLength(10);
    expect(body.schools.every(school => school.sector === 'private')).toBe(true);
    expect(body.pagination).toEqual({
      privateAfter: 'private-token-10',
      privateHasMore: true
    });
    const pipeline = collections.privateSchools.aggregate.mock.calls[0][0];
    expect(pipeline[0].$search.searchAfter).toBe('previous-private-token');
  });

  test('returns the complete empty initial-search response shape', async () => {
    mockConnectDatabase.mockResolvedValue(searchCollections());

    const response = await search({ query: { q: 'no matches' } });

    expect(response.statusCode).toBe(200);
    expect(responseBody(response)).toEqual({
      locations: [],
      schools: [],
      pagination: {
        publicHasMore: false,
        privateHasMore: false,
        locationHasMore: false
      }
    });
  });

  test('returns public and private school groups for a city location', async () => {
    const publicFind = jest.fn().mockReturnValue({
      toArray: jest.fn().mockResolvedValue([
        { _id: 'public-1', school_name: 'Seattle Public School' }
      ])
    });
    const privateFind = jest.fn().mockReturnValue({
      toArray: jest.fn().mockResolvedValue([
        { _id: 'private-1', school_name: 'Seattle Private School' }
      ])
    });
    mockConnectDatabase.mockResolvedValue({
      publicSchools: { find: publicFind },
      privateSchools: { find: privateFind }
    });

    const response = await locationSchools({
      pathParameters: { id: 'city:WA:Seattle' }
    });
    const expectedFilter = {
      'address.location.state': 'WA',
      'address.location.city': {
        $regex: '^Seattle$',
        $options: 'i'
      }
    };

    expect(response.statusCode).toBe(200);
    expect(responseBody(response)).toEqual({
      publicResults: [
        {
          _id: 'public-1',
          school_name: 'Seattle Public School',
          sector: 'public'
        }
      ],
      privateResults: [
        {
          _id: 'private-1',
          school_name: 'Seattle Private School',
          sector: 'private'
        }
      ]
    });
    expect(publicFind).toHaveBeenCalledWith(expectedFilter);
    expect(privateFind).toHaveBeenCalledWith(expectedFilter);
  });
});
