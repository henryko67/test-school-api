require("dotenv").config();

const { MongoClient } = require("mongodb");

const client = new MongoClient(process.env.MONGODB_URI);


async function main() {
  try {
    await client.connect();

    console.log("Connected to MongoDB Atlas");

    const db = client.db("schools");
    const locations = db.collection("locations");

    const result = await locations.updateMany(
      {},
      {
        $unset: {
          city_normalized: "",
          state_name_normalized: ""
        }
      }
    );

    console.log(`Matched: ${result.matchedCount}`);
    console.log(`Modified: ${result.modifiedCount}`);

  } catch (error) {
    console.error(
      "Failed to remove normalized location fields:",
      error
    );

  } finally {
    await client.close();

    console.log("MongoDB connection closed");
  }
}


main();