require('dotenv').config();

const { connectDatabase } = require('../../shared/mongodb');
const {
  createLocationSearchPipeline,
  createMapSearchFilter,
  createSchoolSearchPipeline,
  searchIndexes,
  searchPageSizes
} = require('../../shared/search');
const { createLambdaHandler } = require('../shared/handler');
const { jsonResponse } = require('../shared/http');
const { createRouter } = require('../shared/router');

/**
 * Runs the initial cross-group Atlas Search or continues one result group using
 * an opaque `after` token paired with its `type`.
 *
 * @param {object} request Normalized request containing search query parameters.
 * @returns {Promise<object>} API Gateway JSON proxy response with results and pagination metadata.
 */
async function search(request) {
  try {
    const q = request.query.q?.trim();
    const type = request.query.type;
    const after = request.query.after;

    if (!q) {
      return jsonResponse(400, { error: 'Missing search query' });
    }

    if ((type && !after) || (!type && after)) {
      return jsonResponse(400, {
        error: 'Pagination requires both type and after'
      });
    }

    if (type && !['public', 'private', 'location'].includes(type)) {
      return jsonResponse(400, { error: 'Invalid search type' });
    }

    const { publicSchools, privateSchools, locations } =
      await connectDatabase();

    if (type === 'public' && after) {
      const results = await publicSchools
        .aggregate(
          createSchoolSearchPipeline(
            q,
            searchIndexes.publicSchools,
            after
          )
        )
        .toArray();
      const hasMore = results.length > searchPageSizes.schools;
      const schools = results
        .slice(0, searchPageSizes.schools)
        .map(school => ({ ...school, sector: 'public' }));
      const publicAfter = schools[schools.length - 1]?.paginationToken;

      return jsonResponse(200, {
        schools,
        pagination: { publicAfter, publicHasMore: hasMore }
      });
    }

    if (type === 'private' && after) {
      const results = await privateSchools
        .aggregate(
          createSchoolSearchPipeline(
            q,
            searchIndexes.privateSchools,
            after
          )
        )
        .toArray();
      const hasMore = results.length > searchPageSizes.schools;
      const schools = results
        .slice(0, searchPageSizes.schools)
        .map(school => ({ ...school, sector: 'private' }));
      const privateAfter = schools[schools.length - 1]?.paginationToken;

      return jsonResponse(200, {
        schools,
        pagination: { privateAfter, privateHasMore: hasMore }
      });
    }

    if (type === 'location' && after) {
      const results = await locations
        .aggregate(createLocationSearchPipeline(q, after))
        .toArray();
      const hasMore = results.length > searchPageSizes.locations;
      const locationPage = results.slice(0, searchPageSizes.locations);
      const locationAfter =
        locationPage[locationPage.length - 1]?.paginationToken;

      return jsonResponse(200, {
        locations: locationPage,
        pagination: { locationAfter, locationHasMore: hasMore }
      });
    }

    const [publicResults, privateResults, locationResults] =
      await Promise.all([
        publicSchools
          .aggregate(
            createSchoolSearchPipeline(q, searchIndexes.publicSchools)
          )
          .toArray(),
        privateSchools
          .aggregate(
            createSchoolSearchPipeline(q, searchIndexes.privateSchools)
          )
          .toArray(),
        locations.aggregate(createLocationSearchPipeline(q)).toArray()
      ]);

    const publicHasMore = publicResults.length > searchPageSizes.schools;
    const privateHasMore = privateResults.length > searchPageSizes.schools;
    const locationHasMore = locationResults.length > searchPageSizes.locations;
    const publicPage = publicResults.slice(0, searchPageSizes.schools);
    const privatePage = privateResults.slice(0, searchPageSizes.schools);
    const locationPage = locationResults.slice(0, searchPageSizes.locations);
    const publicAfter = publicPage[publicPage.length - 1]?.paginationToken;
    const privateAfter = privatePage[privatePage.length - 1]?.paginationToken;
    const locationAfter = locationPage[locationPage.length - 1]?.paginationToken;
    const schools = [
      ...publicPage.map(school => ({ ...school, sector: 'public' })),
      ...privatePage.map(school => ({ ...school, sector: 'private' }))
    ];

    schools.sort((a, b) => b.score - a.score);

    return jsonResponse(200, {
      locations: locationPage,
      schools,
      pagination: {
        publicAfter,
        privateAfter,
        locationAfter,
        publicHasMore,
        privateHasMore,
        locationHasMore
      }
    });
  } catch (error) {
    console.error('Search failed:', error);
    return jsonResponse(500, { error: 'Internal server error' });
  }
}

/**
 * Retrieves public and private schools for a `state:*` or `city:*` location ID.
 *
 * @param {object} request Normalized request with a location `id` path parameter.
 * @returns {Promise<object>} API Gateway JSON proxy response.
 */
async function locationSchools(request) {
  try {
    const { id } = request.pathParameters;
    const parts = id.split(':');
    const type = parts[0];
    const state = parts[1];
    const city = parts[2];

    if (type === 'city' && parts.length !== 3) {
      return jsonResponse(400, { error: 'Invalid city location id' });
    } else if (type === 'state' && parts.length !== 2) {
      return jsonResponse(400, { error: 'Invalid state location id' });
    }

    let filter;

    if (type === 'state') {
      filter = { 'address.location.state': state };
    } else if (type === 'city') {
      filter = {
        'address.location.state': state,
        'address.location.city': {
          $regex: `^${city}$`,
          $options: 'i'
        }
      };
    } else {
      return jsonResponse(400, { error: 'Invalid location type' });
    }

    const { publicSchools, privateSchools } = await connectDatabase();
    const [publicResults, privateResults] = await Promise.all([
      publicSchools.find(filter).toArray(),
      privateSchools.find(filter).toArray()
    ]);

    return jsonResponse(200, {
      publicResults: publicResults.map(school => ({
        ...school,
        sector: 'public'
      })),
      privateResults: privateResults.map(school => ({
        ...school,
        sector: 'private'
      }))
    });
  } catch (error) {
    console.error('Location school lookup failed:', error);
    return jsonResponse(500, { error: 'Internal server error' });
  }
}

/**
 * Retrieves public and private schools inside validated latitude/longitude
 * bounds.
 *
 * @param {object} request Normalized request containing map-bound query parameters.
 * @returns {Promise<object>} API Gateway JSON proxy response.
 */
async function mapSearch(request) {
  try {
    const north = Number(request.query.north);
    const south = Number(request.query.south);
    const east = Number(request.query.east);
    const west = Number(request.query.west);

    if (
      !Number.isFinite(north) ||
      !Number.isFinite(south) ||
      !Number.isFinite(east) ||
      !Number.isFinite(west) ||
      north < -90 ||
      north > 90 ||
      south < -90 ||
      south > 90 ||
      east < -180 ||
      east > 180 ||
      west < -180 ||
      west > 180 ||
      south > north
    ) {
      return jsonResponse(400, { error: 'Invalid map bounds' });
    }

    const filter = createMapSearchFilter(north, south, east, west);
    const { publicSchools, privateSchools } = await connectDatabase();
    const [publicResults, privateResults] = await Promise.all([
      publicSchools.find(filter).toArray(),
      privateSchools.find(filter).toArray()
    ]);

    return jsonResponse(200, {
      publicResults: publicResults.map(school => ({
        ...school,
        sector: 'public'
      })),
      privateResults: privateResults.map(school => ({
        ...school,
        sector: 'private'
      }))
    });
  } catch (error) {
    console.error('Map-based school lookup failed:', error);
    return jsonResponse(500, { error: 'Internal server error' });
  }
}

const router = createRouter([
  { method: 'GET', path: '/api/search', handler: search },
  {
    method: 'GET',
    path: '/api/locations/:id/schools',
    handler: locationSchools
  },
  { method: 'GET', path: '/api/map-search', handler: mapSearch }
]);

module.exports = {
  handler: createLambdaHandler(router),
  locationSchools,
  mapSearch,
  search
};
