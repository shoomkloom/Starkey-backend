const { MongoClient } = require('mongodb');
require('dotenv').config({ quiet: true });

const client = new MongoClient(process.env.MONGODB_URI);
let db;

async function connectToMongo() {
    if (!db) {
        await client.connect();
        db = client.db(process.env.MONGODB_DBNAME);
    }
    return db;
}

module.exports = { connectToMongo };
