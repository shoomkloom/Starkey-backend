const puppeteer = require('puppeteer');
const OpenAI = require('openai');
require('dotenv').config({ quiet: true });
const { connectToMongo } = require('./db');

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

async function fetchWebpageContent(url) {
    const browser = await puppeteer.launch({ headless: 'new' });
    const page = await browser.newPage();

    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64)');
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });

    const title = await page.title();
    const bodyText = await page.evaluate(() => {
        return document.body.innerText;
    });

    await browser.close();
    return { title, bodyText: bodyText.replace(/\s+/g, ' ').trim() };
}

function chunkText(text, maxWords = 200) {
    const words = text.split(' ');
    const chunks = [];
    for (let i = 0; i < words.length; i += maxWords) {
        const chunk = words.slice(i, i + maxWords).join(' ');
        if (chunk.length > 20) chunks.push(chunk); // skip very short ones
    }
    return chunks;
}

async function embedChunks(chunks) {
    const response = await openai.embeddings.create({
        model: "text-embedding-3-small",
        input: chunks
    });

    return response.data.map((item, i) => ({
        text: chunks[i],
        embedding: item.embedding
    }));
}

async function saveSiteEmbedding({ url, title, chunkEmbeddings }, collection) {
    const doc = {
        url,
        title,
        chunks: chunkEmbeddings,
        createdAt: new Date()
    };

    await collection.insertOne(doc);
}

async function processAndStoreUrl(url, collection) {
    const { title, bodyText } = await fetchWebpageContent(url);
    const chunks = chunkText(bodyText);
    const chunkEmbeddings = await embedChunks(chunks);

    const db = await connectToMongo();
    const dbCollection = db.collection(collection);
    await saveSiteEmbedding({ url, title, chunkEmbeddings }, dbCollection);

    console.log(`Embedded and stored ${chunks.length} chunks from ${url}`);
}

function cosineSimilarity(a, b) {
    const dot = a.reduce((sum, val, i) => sum + val * b[i], 0);
    const normA = Math.sqrt(a.reduce((sum, val) => sum + val * val, 0));
    const normB = Math.sqrt(b.reduce((sum, val) => sum + val * val, 0));
    return dot / (normA * normB);
}

async function searchSimilarClientSide(queryText, dbCollection, numTopLinks) {
    const queryEmbedding = (await openai.embeddings.create({
        model: "text-embedding-3-small",
        input: [queryText]
    })).data[0].embedding;

    // Fetch all site docs (or filter by URL, etc.)
    const allDocs = await dbCollection.find({}).toArray();

    let allChunks = [];
    for (const doc of allDocs) {
        for (const chunk of doc.chunks) {
            allChunks.push({
                text: chunk.text,
                embedding: chunk.embedding,
                url: doc.url,
                title: doc.title
            });
        }
    }

    // Score chunks by cosine similarity
    const scoredChunks = allChunks.map(chunk => ({
        ...chunk,
        score: cosineSimilarity(queryEmbedding, chunk.embedding)
    }));

    // Sort and return topN
    scoredChunks.sort((a, b) => b.score - a.score);
    return scoredChunks.slice(0, numTopLinks);
}


// Export the functions
module.exports = { processAndStoreUrl, searchSimilarClientSide };
