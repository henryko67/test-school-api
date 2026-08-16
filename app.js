require("dotenv").config();

const { MongoClient } = require("mongodb");
const express = require("express");
const swaggerUi = require("swagger-ui-express");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

const client = new MongoClient(process.env.MONGODB_URI);

let privateSchools;


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

        "/api/schools/search": {
            get: {
                summary: "Search for schools",

                parameters: [
                    {
                        name: "q",
                        in: "query",
                        required: true,

                        schema: {
                            type: "string"
                        },

                        description: "School name or location"
                    }
                ],

                responses: {
                    200: {
                        description: "Search results"
                    }
                }
            }
        },

        "/api/search": {
            get: {
                summary: "Search for schools given input text",

                parameters: [
                    {
                        name: "q",
                        in: "query",
                        required: true,

                        schema: {
                            type: "string"
                        },

                        description: "School name or location"
                    }
                ],

                responses: {
                    200: {
                        description: "Search results"
                    },

                    400: {
                        description: "Missing search query"
                    },

                    500: {
                        description: "Internal server error"
                    }
                }
            }
        }
    }
};


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


app.get("/api/schools/search", (req, res) => {
    const query = req.query.q;

    res.json({
        query: query,
        results: []
    });
});


app.get("/api/search", async (req, res) => {
    try {
        const q = req.query.q?.trim();

        if (!q) {
            return res.status(400).json({
                error: "Missing search query"
            });
        }

        const pipeline = [
            {
                $search: {
                    index: "private_school_search",

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
                            }
                        ],

                        minimumShouldMatch: 1
                    }
                }
            },

            {
                $limit: 10
            },

            {
                $project: {
                    _id: 1,
                    school_name: 1,
                    "address.location": 1,
                    location: 1,

                    score: {
                        $meta: "searchScore"
                    }
                }
            }
        ];

        const results = await privateSchools
            .aggregate(pipeline)
            .toArray();

        res.json(results);

    } catch (error) {
        console.error("Search failed:", error);

        res.status(500).json({
            error: "Internal server error"
        });
    }
});


async function startServer() {
    try {
        await client.connect();

        console.log("Connected to MongoDB Atlas");

        const db = client.db("schools");

        privateSchools = db.collection("private-schools");

        /**
        //Test connection code (ERASE LATER)
        console.log(
            "Private school count:",
            await privateSchools.countDocuments()
        );

        console.log(
            "Sample school:",
            await privateSchools.findOne()
        );

        */

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