require('dotenv').config();

const { connectDatabase } = require('../../shared/mongodb');
const { isValidSchoolSector } = require('../../shared/validation');
const { createLambdaHandler } = require('../shared/handler');
const { jsonResponse } = require('../shared/http');
const { createRouter } = require('../shared/router');

/**
 * Retrieves a base public/private school document and annotates its sector.
 *
 * @param {object} request Normalized request with `sector` and `id` path parameters.
 * @returns {Promise<object>} API Gateway JSON proxy response.
 */
async function getSchool(request) {
  try {
    const { sector, id } = request.pathParameters;

    if (!isValidSchoolSector(sector)) {
      return jsonResponse(400, { error: 'Invalid school sector' });
    }

    const { publicSchools, privateSchools } = await connectDatabase();
    const collection = sector === 'public' ? publicSchools : privateSchools;

    const school = await collection.findOne({ _id: id });

    if (!school) {
      return jsonResponse(404, { error: 'School not found' });
    }

    return jsonResponse(200, { ...school, sector });
  } catch (error) {
    console.error('School lookup failed:', error);
    return jsonResponse(500, { error: 'Internal server error' });
  }
}

/**
 * Retrieves teacher/staff and discipline detail documents for a public school.
 * Missing detail documents are returned as `null` rather than a 404.
 *
 * @param {object} request Normalized request with `sector` and `id` path parameters.
 * @returns {Promise<object>} API Gateway JSON proxy response.
 */
async function getSchoolDetails(request) {
  try {
    const { sector, id } = request.pathParameters;

    if (sector !== 'public') {
      return jsonResponse(400, {
        error: 'Detailed CRDC data is only available for public schools'
      });
    }

    const { teachersStaff, discipline } = await connectDatabase();
    const [teachersStaffResult, disciplineResult] = await Promise.all([
      teachersStaff.findOne({ _id: id }),
      discipline.findOne({ _id: id })
    ]);

    return jsonResponse(200, {
      teachersStaff: teachersStaffResult,
      discipline: disciplineResult
    });
  } catch (error) {
    console.error('Failed to fetch school details:', error);
    return jsonResponse(500, { error: 'Failed to fetch school details' });
  }
}

const router = createRouter([
  {
    method: 'GET',
    path: '/api/schools/:sector/:id/details',
    handler: getSchoolDetails
  },
  {
    method: 'GET',
    path: '/api/schools/:sector/:id',
    handler: getSchool
  }
]);

module.exports = {
  getSchool,
  getSchoolDetails,
  handler: createLambdaHandler(router)
};
