require("dotenv").config();

const { MongoClient } = require("mongodb");

const client = new MongoClient(process.env.MONGODB_URI);


function formatCityName(city) {
  if (!city) {
    return city;
  }

  return city
    .toLowerCase()
    .split(/\s+/)
    .map(word => {
      if (!word) {
        return word;
      }

      return word[0].toUpperCase() + word.slice(1);
    })
    .join(" ");
}


async function main() {
  try {
    await client.connect();

    console.log("Connected to MongoDB Atlas");

    const db = client.db("schools");
    const locations = db.collection("locations");

    const cityDocs = await locations
      .find({ type: "city" })
      .project({
        _id: 1,
        city: 1,
        state: 1
      })
      .toArray();

    console.log(`Found ${cityDocs.length} city locations`);

    const operations = cityDocs.map(doc => {
      const formattedCity = formatCityName(doc.city);

      return {
        updateOne: {
          filter: {
            _id: doc._id
          },

          update: {
            $set: {
              city: formattedCity,
              label: `${formattedCity}, ${doc.state}`
            }
          }
        }
      };
    });

    if (operations.length === 0) {
      console.log("No city documents to update");
      return;
    }

    const result = await locations.bulkWrite(operations);

    console.log(`Matched: ${result.matchedCount}`);
    console.log(`Modified: ${result.modifiedCount}`);

  } catch (error) {
    console.error("Failed to normalize locations:", error);
  } finally {
    await client.close();

    console.log("MongoDB connection closed");
  }
}


main();