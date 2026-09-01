const config = {
  mongodb: {
    databaseName: process.env.MONGODB_DATABASE || 'schools',
    ssmParameterName: '/k12info/prod/mongodb-uri',
    collections: {
      privateSchools:
        process.env.MONGODB_PRIVATE_SCHOOLS_COLLECTION || 'private-schools',
      publicSchools:
        process.env.MONGODB_PUBLIC_SCHOOLS_COLLECTION || 'public-schools',
      locations:
        process.env.MONGODB_LOCATIONS_COLLECTION || 'locations',
      users:
        process.env.MONGODB_USERS_COLLECTION || 'users',
      comments:
        process.env.MONGODB_COMMENTS_COLLECTION || 'comments',
      teachersStaff:
        process.env.MONGODB_TEACHERS_STAFF_COLLECTION || 'teachers-staff',
      discipline:
        process.env.MONGODB_DISCIPLINE_COLLECTION || 'discipline'
    }
  },
  cognito: {
    userPoolId:
      process.env.COGNITO_USER_POOL_ID || 'us-west-2_EynLi5Xsa',
    clientId:
      process.env.COGNITO_CLIENT_ID || '5v0o2glgka87uc3dnotn2pohgc'
  },
  websocket: {
    tableName:
      process.env.WEBSOCKET_STATE_TABLE || 'K12InfoWebSocketState',
    ticketTtlSeconds: 60,
    connectionTtlSeconds: 3 * 60 * 60
  },
  atlasSearch: {
    indexes: {
      publicSchools:
        process.env.ATLAS_PUBLIC_SCHOOL_SEARCH_INDEX ||
        'public_school_search',
      privateSchools:
        process.env.ATLAS_PRIVATE_SCHOOL_SEARCH_INDEX ||
        'private_school_search',
      locations:
        process.env.ATLAS_LOCATION_SEARCH_INDEX || 'location_search'
    },
    pageSizes: {
      schools: 10,
      locations: 5
    }
  }
};

module.exports = config;
