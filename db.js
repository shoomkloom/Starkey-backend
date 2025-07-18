const { MongoClient } = require('mongodb');
require('dotenv').config({ quiet: true });

const client = new MongoClient('mongodb+srv://starkey:Kloom1234@cluster0.fcsm7.mongodb.net/'); //Hardcoded for simplicity, use environment variables in production
let db;

async function connectToMongo() {
    if (!db) {
        await client.connect();
        db = client.db('starkey'); //Hardcoded for simplicity, use environment variables in production
    }
    return db;
}

module.exports = { connectToMongo };
