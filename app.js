require("dotenv").config()

const { MongoClient } = require("mongodb");
const express = require("express");
const swaggerUi = require("swagger-ui-express");

const app = express();
//const PORT = process.env.PORT || 3000;

const client = new MongoClient(process.env.MONGODB_URI);

let privateSchools;
let publicSchools;
let locations;

// swagger doc

const swaggerDocument = {
    openapi: "3.0.0",

    info: {
        title: "K12Info API",
        version: "1.0.0",
        description: "Development API for K12Info"
    },

    servers: [
        {
            url: "http://localhost:3000"
        }
    ],

    paths: {
        "/api/test": {
            get: {
                summary: "Test the API",

                responses: {
                    200: {
                        description: "API is working"
                    }
                }
            }
        },

        "/api/search": {
          get: {
            summary: "Search for schools and locations",

            parameters: [
              {
                name: "q",
                in: "query",
                required: true,

                schema: {
                  type: "string"
                },

                description: "School name or location"
              },

              {
                name: "type",
                in: "query",
                required: false,

                schema: {
                  type: "string",
                  enum: ["public", "private", "location"]
                },

                description: "Result type to paginate"
              },

              {
                name: "after",
                in: "query",
                required: false,

                schema: {
                  type: "string"
                },

                description: "Pagination token returned by the previous search"
              }
            ],

            responses: {
              200: {
                description: "Search results"
              },

              400: {
                description: "Invalid search request"
              },

              500: {
                description: "Internal server error"
              }
            }
          }
        }
    }
};

function createSchoolSearchPipeline(q, indexName, after) {
  return [
    {
      $search: {
        index: indexName,

        ...(after && {
            searchAfter: after
        }),

        compound: {
          should: [
            {
              text: {
                query: q,

                path: [
                  "school_name",
                  "address.location.street",
                  "address.location.city",
                  "address.location.state",
                  "address.location.state_name",
                  "address.location.zip"
                ],

                fuzzy: {
                  maxEdits: 1
                }
              }
            },

            {
              autocomplete: {
                query: q,
                path: "school_name",
                tokenOrder: "any",

                fuzzy: {
                  maxEdits: 1
                },

                score: {
                  boost: {
                    value: 3
                  }
                }
              }
            },

            {
                autocomplete: {
                    query: q,
                    path: "address.location.street",
                    tokenOrder: "any",

                    fuzzy: {
                        maxEdits: 1
                    },

                    score: {
                        boost: {
                            value: 2
                        }
                    }
                }
            },

            {
                phrase: {
                    query: q,
                    path: "address.location.street",

                    score: {
                        boost: {
                            value: 5
                        }
                    }
                }
            },

            {
              autocomplete: {
                query: q,
                path: "address.location.city",
                tokenOrder: "any",

                fuzzy: {
                  maxEdits: 1
                }
              }
            },

            {
              autocomplete: {
                query: q,
                path: "address.location.state_name",
                tokenOrder: "any",

                fuzzy: {
                  maxEdits: 1
                }
              }
            },

            {
              text: {
                query: q,
                path: "address.location.state"
              }
            },

            {
              text: {
                query: q,
                path: "address.location.zip"
              }
            }
          ],

          minimumShouldMatch: 1
        }
      }
    },

    {
      $limit: 11
    },

    {
      $project: {
        _id: 1,
        school_name: 1,
        "address.location": 1,
        location: 1,

        score: {
          $meta: "searchScore"
        },

        paginationToken: {
          $meta: "searchSequenceToken"
        }
      }
    }
  ];
}

function createLocationSearchPipeline(q, after) {
  return [
    {
      $search: {
        index: "location_search",

        ...(after && {
            searchAfter: after
        }),

        compound: {
          should: [
            {
              text: {
                query: q,

                path: [
                  "label",
                  "city",
                  "state",
                  "state_name"
                ],

                fuzzy: {
                  maxEdits: 1
                }
              }
            },

            {
              autocomplete: {
                query: q,
                path: "label",
                tokenOrder: "any",

                fuzzy: {
                  maxEdits: 1
                },

                score: {
                  boost: {
                    value: 3
                  }
                }
              }
            },

            {
              autocomplete: {
                query: q,
                path: "city",
                tokenOrder: "any",

                fuzzy: {
                  maxEdits: 1
                }
              }
            },

            {
              autocomplete: {
                query: q,
                path: "state_name",
                tokenOrder: "any",

                fuzzy: {
                  maxEdits: 1
                }
              }
            },

            {
              text: {
                query: q,
                path: "state"
              }
            }
          ],

          minimumShouldMatch: 1
        }
      }
    },

    {
      $limit: 6
    },

    {
      $project: {
        _id: 1,
        type: 1,
        label: 1,
        city: 1,
        state: 1,
        state_name: 1,

        score: {
          $meta: "searchScore"
        },

        paginationToken: {
          $meta: "searchSequenceToken"
        }
      }
    }
  ];
}

//endpoints

app.use(
    "/api-docs",
    swaggerUi.serve,
    swaggerUi.setup(swaggerDocument)
);

app.get("/api/test", (req, res) => {
    res.json({
        message: "API is running!"
    });
});

app.get("/api/search", async (req, res) => {
  try {
    const q = req.query.q?.trim();
    const type = req.query.type;
    const after = req.query.after;

    if (!q) {
      return res.status(400).json({
        error: "Missing search query"
      });
    }

    if ((type && !after) || (!type && after)) {
      return res.status(400).json({
        error: "Pagination requires both type and after"
      });
    }

    if (type && !["public", "private", "location"].includes(type)) {
      return res.status(400).json({
        error: "Invalid search type"
      });
    }

    if (type === "public" && after) {
      const pipeline = createSchoolSearchPipeline(q, "public_school_search", after);

      const results = await publicSchools
        .aggregate(pipeline)
        .toArray();

      const hasMore = results.length > 10;

      const schools = results
        .slice(0, 10)
        .map(school => ({
          ...school,
          sector: "public"
        }));

      const publicAfter = schools[schools.length - 1]?.paginationToken;

      return res.json({
        schools,

        pagination: {
          publicAfter,
          publicHasMore: hasMore
        }
      });
    }

    if (type === "private" && after) {
      const pipeline =
        createSchoolSearchPipeline(
          q,
          "private_school_search",
          after
        );

      const results = await privateSchools
        .aggregate(pipeline)
        .toArray();

      const hasMore = results.length > 10;

      const schools = results
        .slice(0, 10)
        .map(school => ({
          ...school,
          sector: "private"
        }));

      const privateAfter = schools[schools.length - 1]?.paginationToken;

      return res.json({
        schools,

        pagination: {
          privateAfter,
          privateHasMore: hasMore
        }
      });
    }

    if (type === "location" && after) {
      const pipeline =
        createLocationSearchPipeline(q, after);

      const results = await locations
        .aggregate(pipeline)
        .toArray();

      const hasMore = results.length > 5;

      const locationPage = results.slice(0, 5);

      const locationAfter = locationPage[locationPage.length - 1]?.paginationToken;

      return res.json({
        locations: locationPage,

        pagination: {
          locationAfter,
          locationHasMore: hasMore
        }
      });
    }

    const publicPipeline =
      createSchoolSearchPipeline(q, "public_school_search");

    const privatePipeline =
      createSchoolSearchPipeline(q, "private_school_search");

    const locationPipeline =
      createLocationSearchPipeline(q);

    const [
      publicResults,
      privateResults,
      locationResults
    ] = await Promise.all([
      publicSchools.aggregate(publicPipeline).toArray(),
      privateSchools.aggregate(privatePipeline).toArray(),
      locations.aggregate(locationPipeline).toArray()
    ]);

    const publicHasMore = publicResults.length > 10;
    const privateHasMore = privateResults.length > 10;
    const locationHasMore = locationResults.length > 5;

    const publicPage = publicResults.slice(0, 10);
    const privatePage = privateResults.slice(0, 10);
    const locationPage = locationResults.slice(0, 5);

    const publicAfter =
      publicPage[publicPage.length - 1]?.paginationToken;

    const privateAfter =
      privatePage[privatePage.length - 1]?.paginationToken;

    const locationAfter =
      locationPage[locationPage.length - 1]?.paginationToken;

    const schoolResults = [
      ...publicPage.map(school => ({
        ...school,
        sector: "public"
      })),

      ...privatePage.map(school => ({
        ...school,
        sector: "private"
      }))
    ];

    schoolResults.sort(
      (a, b) => b.score - a.score
    );

    res.json({
      locations: locationPage,
      schools: schoolResults,

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
    console.error("Search failed:", error);

    res.status(500).json({
      error: "Internal server error"
    });
  }
});

async function connectDatabase() {
    await client.connect();

    console.log("Connected to MongoDB Atlas");

    const db = client.db("schools");

    privateSchools = db.collection("private-schools");
    publicSchools = db.collection("public-schools");
    locations = db.collection("locations");
}

async function disconnectDatabase() {
    await client.close();
}

module.exports = {
    app,
    connectDatabase,
    disconnectDatabase
};

//server stuff
/**
async function startServer() {
    try {
        await client.connect();

        console.log("Connected to MongoDB Atlas");

        const db = client.db("schools");

        privateSchools = db.collection("private-schools");
        publicSchools = db.collection("public-schools");
        locations = db.collection("locations");

        app.listen(PORT, () => {
            console.log(
                `Server running at http://localhost:${PORT}`
            );

            console.log(
                `Swagger UI at http://localhost:${PORT}/api-docs`
            );
        });

    } catch (error) {
        console.error(
            "Failed to connect to MongoDB:",
            error
        );

        process.exit(1);
    }
}


startServer();
*/