/**
 * Enriches a comment page with school names using one lookup per represented
 * sector. Missing schools receive the stable `Unknown school` label.
 *
 * @param {object[]} page
 * @param {import('mongodb').Collection} publicSchools
 * @param {import('mongodb').Collection} privateSchools
 * @returns {Promise<object[]>}
 */
async function enrichCommentsWithSchoolNames(
  page,
  publicSchools,
  privateSchools
) {
  const publicSchoolIds = page
    .filter(comment => comment.sector === 'public')
    .map(comment => comment.school_id);

  const privateSchoolIds = page
    .filter(comment => comment.sector === 'private')
    .map(comment => comment.school_id);

  const [publicSchoolResults, privateSchoolResults] = await Promise.all([
    publicSchoolIds.length > 0
      ? publicSchools
          .find(
            { _id: { $in: publicSchoolIds } },
            { projection: { _id: 1, school_name: 1 } }
          )
          .toArray()
      : [],
    privateSchoolIds.length > 0
      ? privateSchools
          .find(
            { _id: { $in: privateSchoolIds } },
            { projection: { _id: 1, school_name: 1 } }
          )
          .toArray()
      : []
  ]);

  const schoolNames = new Map();

  for (const school of publicSchoolResults) {
    schoolNames.set(`public:${school._id}`, school.school_name);
  }

  for (const school of privateSchoolResults) {
    schoolNames.set(`private:${school._id}`, school.school_name);
  }

  return page.map(comment => ({
    ...comment,
    school_name:
      schoolNames.get(`${comment.sector}:${comment.school_id}`) ??
      'Unknown school'
  }));
}

module.exports = {
  enrichCommentsWithSchoolNames
};
