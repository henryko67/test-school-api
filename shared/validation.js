function isValidSchoolSector(sector) {
  return sector === 'public' || sector === 'private';
}

/**
 * Checks the complete username contract used for profile creation: 3–20 ASCII
 * letters, numbers, or underscores after trimming.
 *
 * @param {*} username
 * @returns {boolean}
 */
function isValidUsername(username) {
  return (
    typeof username === 'string' &&
    /^[a-zA-Z0-9_]{3,20}$/.test(username.trim())
  );
}

function normalizeUsername(username) {
  return username.trim().toLowerCase();
}

module.exports = {
  isValidSchoolSector,
  isValidUsername,
  normalizeUsername
};
