const puppeteer = require('puppeteer');
const { OpenAI } = require('openai');
require('dotenv').config({ quiet: true });
const { connectToMongo } = require('./db');
const {diffWords} = require('diff');
let responseOpenaiClient = null;

function setEmbeddingsOpenAIClient(openaiClient) {
    responseOpenaiClient = openaiClient;
}

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
    const response = await responseOpenaiClient.embeddings.create({
        model: "text-embedding-3-small",
        input: chunks
    });

    return response.data.map((item, i) => ({
        text: chunks[i],
        embedding: item.embedding
    }));
}

async function saveSiteEmbedding({ url, title, bodyText, chunkEmbeddings, _id, changes }, collection) {
    const doc = {
        url,
        title,
        originalText: bodyText, 
        chunks: chunkEmbeddings,
        changesOrgId: _id, 
        changes: changes,
        createdAt: new Date()
    };

    await collection.insertOne(doc);
}

async function compareExisting(url, bodyText, collection) {
    const existingDoc = await collection.findOne(
        { url },                              // match by url
        { sort: { createdAt: -1 } }           // sort by createdAt descending
    );
    if(existingDoc) {
        // Compare with new bodyText and ignore whitespace
        const differences = diffWords(existingDoc.originalText, bodyText, { ignoreWhitespace: true, ignoreCase: true, oneChangePerToken: true });

        // Filter the differences to show only changes
        const changes = [];
        let currentChange = null;

        for (const part of differences) {
            if (part.added || part.removed) {
                const type = part.added ? 'added' : 'removed';
                if (currentChange && currentChange.type === type) {
                    currentChange.text += ' ' + part.value.trim();
                } 
                else {
                    if (currentChange) {
                        currentChange.text = currentChange.text.trim();
                        changes.push(currentChange);
                    }
                    currentChange = {
                        type: type,
                        text: part.value
                    };
                }
            } 
            else {
                // End of a change block
                if (currentChange) {
                    changes.push(currentChange);
                    currentChange = null;
                }
            }
        }

        // Push any remaining change
        if (currentChange) {
            changes.push(currentChange);
        }

        return { _id: existingDoc._id, changes };
    } 
    else {
        return { _id: null, changes: [] };
    }
}

async function processUrl(url, collectionName) {
    const db = await connectToMongo();
    const dbCollection = db.collection(collectionName);
    await processAndStoreUrl(url, dbCollection);
}

async function processAllDiffs() {
    const db = await connectToMongo();
    const dbCollection = db.collection('links');
    const allLinks = await dbCollection.find({}).toArray();
    allLinks.forEach(async link => {
        try{
            await processAndStoreUrl(link.url, dbCollection);
        }
        catch (err) {
            console.error(`Error processing link ${link.url}:`, err);
        }
    });
}

async function processAndStoreUrl(url, dbCollection) {
    const { title, bodyText } = await fetchWebpageContent(url);
    const chunks = chunkText(bodyText);
    const chunkEmbeddings = await embedChunks(chunks);
    
    const { _id, changes } = await compareExisting(url, bodyText, dbCollection);
    if (!_id || (changes && changes.length > 0)) {
        await saveSiteEmbedding({ url, title, bodyText, chunkEmbeddings, _id, changes }, dbCollection);
        console.log(`Embedded and stored ${chunks.length} chunks from ${url}`);
    } 
    else {
        console.log(`No significant changes found for ${url}. Skipping storage.`);
    }

    return changes;
}



function cosineSimilarity(a, b) {
    const dot = a.reduce((sum, val, i) => sum + val * b[i], 0);
    const normA = Math.sqrt(a.reduce((sum, val) => sum + val * val, 0));
    const normB = Math.sqrt(b.reduce((sum, val) => sum + val * val, 0));
    return dot / (normA * normB);
}

async function searchSimilarClientSide(queryText, dbCollection, numTopLinks) {
    const embeddingsClient = new OpenAI({ apiKey: process.env.OPENAI_KEY }); //We need a new OpenAI client for embeddings
    const queryEmbedding = (await embeddingsClient.embeddings.create({
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

    console.log(`Found ${allChunks.length} chunks in ${allDocs.length} web link data sets.`);

    // Sort and return topN
    scoredChunks.sort((a, b) => b.score - a.score);
    return scoredChunks.slice(0, numTopLinks);
}


// Export the functions
module.exports = { setEmbeddingsOpenAIClient, processUrl, searchSimilarClientSide, processAllDiffs };
