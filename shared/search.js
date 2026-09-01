const config = require('./config');

const { indexes, pageSizes } = config.atlasSearch;

/**
 * Builds an Atlas Search pipeline for one school sector.
 *
 * @param {string} q
 * @param {string} indexName
 * @param {string} [after] Opaque Atlas Search sequence token.
 * @returns {object[]} MongoDB aggregation pipeline requesting one lookahead row.
 */
function createSchoolSearchPipeline(q, indexName, after) {
  return [
    {
      $search: {
        index: indexName,
        ...(after && { searchAfter: after }),
        compound: {
          should: [
            {
              text: {
                query: q,
                path: [
                  'school_name',
                  'address.location.street',
                  'address.location.city',
                  'address.location.state',
                  'address.location.state_name',
                  'address.location.zip'
                ],
                fuzzy: { maxEdits: 1 }
              }
            },
            {
              autocomplete: {
                query: q,
                path: 'school_name',
                tokenOrder: 'any',
                fuzzy: { maxEdits: 1 },
                score: { boost: { value: 3 } }
              }
            },
            {
              autocomplete: {
                query: q,
                path: 'address.location.street',
                tokenOrder: 'any',
                fuzzy: { maxEdits: 1 },
                score: { boost: { value: 2 } }
              }
            },
            {
              phrase: {
                query: q,
                path: 'address.location.street',
                score: { boost: { value: 5 } }
              }
            },
            {
              autocomplete: {
                query: q,
                path: 'address.location.city',
                tokenOrder: 'any',
                fuzzy: { maxEdits: 1 }
              }
            },
            {
              autocomplete: {
                query: q,
                path: 'address.location.state_name',
                tokenOrder: 'any',
                fuzzy: { maxEdits: 1 }
              }
            },
            {
              text: {
                query: q,
                path: 'address.location.state'
              }
            },
            {
              text: {
                query: q,
                path: 'address.location.zip'
              }
            }
          ],
          minimumShouldMatch: 1
        }
      }
    },
    {
      $limit: pageSizes.schools + 1
    },
    {
      $project: {
        _id: 1,
        school_name: 1,
        'address.location': 1,
        score: { $meta: 'searchScore' },
        paginationToken: { $meta: 'searchSequenceToken' }
      }
    }
  ];
}

/**
 * Builds the Atlas Search pipeline for location results.
 *
 * @param {string} q
 * @param {string} [after] Opaque Atlas Search sequence token.
 * @returns {object[]} MongoDB aggregation pipeline requesting one lookahead row.
 */
function createLocationSearchPipeline(q, after) {
  return [
    {
      $search: {
        index: indexes.locations,
        ...(after && { searchAfter: after }),
        compound: {
          should: [
            {
              text: {
                query: q,
                path: ['label', 'city', 'state', 'state_name'],
                fuzzy: { maxEdits: 1 }
              }
            },
            {
              autocomplete: {
                query: q,
                path: 'label',
                tokenOrder: 'any',
                fuzzy: { maxEdits: 1 },
                score: { boost: { value: 3 } }
              }
            },
            {
              autocomplete: {
                query: q,
                path: 'city',
                tokenOrder: 'any',
                fuzzy: { maxEdits: 1 }
              }
            },
            {
              autocomplete: {
                query: q,
                path: 'state_name',
                tokenOrder: 'any',
                fuzzy: { maxEdits: 1 }
              }
            },
            {
              text: {
                query: q,
                path: 'state'
              }
            }
          ],
          minimumShouldMatch: 1
        }
      }
    },
    {
      $limit: pageSizes.locations + 1
    },
    {
      $project: {
        _id: 1,
        type: 1,
        label: 1,
        city: 1,
        state: 1,
        state_name: 1,
        score: { $meta: 'searchScore' },
        paginationToken: { $meta: 'searchSequenceToken' }
      }
    }
  ];
}

/**
 * Builds the GeoJSON polygon filter used for map-bound school queries.
 *
 * @param {number} north
 * @param {number} south
 * @param {number} east
 * @param {number} west
 * @returns {object} MongoDB geospatial filter.
 */
function createMapSearchFilter(north, south, east, west) {
  return {
    location: {
      $geoWithin: {
        $geometry: {
          type: 'Polygon',
          coordinates: [[
            [west, south],
            [east, south],
            [east, north],
            [west, north],
            [west, south]
          ]]
        }
      }
    }
  };
}

module.exports = {
  createLocationSearchPipeline,
  createMapSearchFilter,
  createSchoolSearchPipeline,
  searchIndexes: indexes,
  searchPageSizes: pageSizes
};
