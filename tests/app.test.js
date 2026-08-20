const request = require("supertest");
const { app, connectDatabase, disconnectDatabase } = require("../app");

describe("GET /api/test", () => {

    test("should return API running message", async () => {

        const response = await request(app)
            .get("/api/test");

        expect(response.statusCode).toBe(200);

        expect(response.body).toEqual({
            message: "API is running!"
        });
    });

});

describe("GET /api/search", () => {

    beforeAll(async () => {
        await connectDatabase();
    });

    afterAll(async() => {
        await disconnectDatabase();
    });
    
    test("returns 400 when query is missing", async () => {

        const response = await request(app)
            .get("/api/search");
        
        expect(response.statusCode).toBe(400);
    });

    test("returns 400 when subfield query is missing (after field missing)", async () => {

        const firstResponse = await request(app)
            .get("/api/search")
            .query({q: "Seattle"});
        
        expect(firstResponse.statusCode).toBe(200);

        const secondResponse = await request(app)
            .get("/api/search")
            .query({q: "Seattle", type: "location", after: ""});
        
        expect(secondResponse.statusCode).toBe(400);
    });

    test("returns 400 when subfield query is missing (location field missing)", async () => {

        const firstResponse = await request(app)
            .get("/api/search")
            .query({q: "Seattle"});
        
        expect(firstResponse.statusCode).toBe(200);

        const token = firstResponse.body.pagination.publicAfter;

        const secondResponse = await request(app)
            .get("/api/search")
            .query({q: "Seattle", type:"", after: "token"});
        
        expect(secondResponse.statusCode).toBe(400);
    });

    test("returns 400 when both subfields are invalid", async () => {

        const firstResponse = await request(app)
            .get("/api/search")
            .query({q: "Seattle"});
        
        expect(firstResponse.statusCode).toBe(200);

        const secondResponse = await request(app)
            .get("/api/search")
            .query({q: "Seattle", type:"weirdo", after: "beardo"});
        
        expect(secondResponse.statusCode).toBe(400);
    });

    test("returns Seattle, WA in location results", async () => {

        const response = await request(app)
            .get("/api/search")
            .query({ q: "Seattle" });
        
        expect(response.statusCode).toBe(200);
        
        //Same thing!
        //expect(response.body.locations.some(location => location._id === "city:WA:seattle")).toBe(true);

        expect(response.body.locations).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    _id: "city:WA:seattle"
                })
            ])
        );
    });

    test("returns no additional location results after Seattle pagination", async () => {

        const firstResponse = await request(app)
            .get("/api/search")
            .query({ q: "Seattle" });
        
        expect(firstResponse.statusCode).toBe(200);

        const token = firstResponse.body.pagination.locationAfter;

        expect(firstResponse.body.locations).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    _id: "city:WA:seattle"
                })
            ])
        );

        const secondResponse = await request(app)
            .get("/api/search")
            .query({q: "Seattle", type: "location", after: token});

        expect(secondResponse.statusCode).toBe(200);

        expect(secondResponse.body.locations).toEqual([]);

        expect(secondResponse.body.pagination.locationHasMore).toBe(false);
    });

    test("returns additional location results when pagination token is provided", async () => {

        const firstResponse = await request(app)
            .get("/api/search")
            .query({ q: "Portland"});

        expect(firstResponse.statusCode).toBe(200);

        const token = firstResponse.body.pagination.locationAfter;

        //incase an unexpected undefied or no additional results happens
        expect(token).toBeDefined();

        const secondResponse = await request(app)
            .get("/api/search")
            .query({q: "Portland", type: "location", after: token});

        expect(secondResponse.statusCode).toBe(200);

        expect(
            secondResponse.body.pagination.locationAfter
        ).not.toBe(token);
    });

    test("returns additional public schools results when pagination token is provided", async () => {

        const firstResponse = await request(app)
            .get("/api/search")
            .query({ q: "Portland"});

        expect(firstResponse.statusCode).toBe(200);

        const token = firstResponse.body.pagination.publicAfter;

        //incase an unexpected undefied or no additional results happens
        expect(token).toBeDefined();

        const secondResponse = await request(app)
            .get("/api/search")
            .query({q: "Portland", type: "public", after: token});

        expect(secondResponse.statusCode).toBe(200);

        expect(
            secondResponse.body.pagination.publicAfter
        ).not.toBe(token);
    });

    test("returns additional private schools results when pagination token is provided", async () => {

        const firstResponse = await request(app)
            .get("/api/search")
            .query({ q: "Portland"});

        expect(firstResponse.statusCode).toBe(200);

        const token = firstResponse.body.pagination.privateAfter;

        //incase an unexpected undefied or no additional results happens
        expect(token).toBeDefined();

        const secondResponse = await request(app)
            .get("/api/search")
            .query({q: "Portland", type: "private", after: token});

        expect(secondResponse.statusCode).toBe(200);

        expect(
            secondResponse.body.pagination.privateAfter
        ).not.toBe(token);
    });

    test("returns empty results for a valid query with no matches", async () => {

        const response = await request(app)
            .get("/api/search")
            .query({ q: "xkcd"});

        expect(response.statusCode).toBe(200);

        expect(response.body.locations).toEqual([]);
        expect(response.body.schools).toEqual([]);
        expect(response.body.pagination.publicHasMore).toBe(false);
        expect(response.body.pagination.privateHasMore).toBe(false);
        expect(response.body.pagination.locationHasMore).toBe(false);
    });

});