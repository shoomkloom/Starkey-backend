const express = require('express');
const multer = require('multer');
const cors = require('cors');
const AgentResponse = require('./agent-response');
require('dotenv').config({ quiet: true });
const { connectToMongo } = require('./db');
const fs = require('fs');
const path = require('path');
const { processUrl, processAllDiffs } = require('./embeddings');
const sysParams = require('./sysparams');

globalThis.File = require('node:buffer').File; //Required by OpenAI SDK for file handling
const app = express();
const upload = multer({ storage: multer.memoryStorage() });
app.use(cors());
app.use(express.json());
let agentResponse = null;

app.get('/', (req, res) => {
  res.send(`
    <h2>Starkey Server</h2>
    <h1>Welcome!</h1>
  `);
});

app.post('/api/sysparams', async (req, res) => {
    const {
        openaiKey,
        modelName,
        historyLength,
        temperature,
        numTopFiles,
        numTopLinks
    } = req.body;

    sysParams.setParams({
        openaiKey,
        modelName,
        historyLength,
        temperature,
        numTopFiles,
        numTopLinks
    });

    agentResponse = new AgentResponse();

    res.status(200).json({ message: 'System parameters updated successfully.' });
});

app.post('/api/chat', async (req, res) => {
    const message = req.body.message;
    
    try {
        const reply = await agentResponse.run(message);
        res.status(200).send(reply);
    } 
    catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/upload', upload.single('file'), async (req, res) => {
    console.debug(`POST /api/upload invoked with the file: ${req.file.originalname}`);
    let localFilePath = '';
    try {
        if (req.file.size > 20 * 1024 * 1024) {
            return res.status(400).json({ error: 'File exceeds OpenAI 20MB upload limit.' });
        }

        // Save file and upload to OpenAI
        localFilePath = await agentResponse.processFile(req.file);
    } 
    catch (err) {
        console.error('Upload error:', err);
        res.status(500).json({ error: 'Upload failed', details: err.message });
    }

    res.status(200).json({ message: 'Uploaded & saved', path: localFilePath });
});

app.post('/api/link', async (req, res) => {
    console.debug(`POST /api/link invoked with the url: ${req.body.link}`);
    try{
        const differences = await processUrl(req.body.link, 'links');
        res.status(200).json({ message: 'Link processing complete', differences: differences });
    }
    catch (err) {
        console.error('api/link error:', err);
        res.status(500).json({ error: 'link processing failed', details: err.message });
    }
});

app.get('/api/diffcheck', async (req, res) => {
    console.debug(`GET /api/diffcheck invoked.`);
    try{
        await processAllDiffs();
        console.debug(`All links processed for differences.`);
        res.status(200).json({ message: 'Diff All processing complete' });
    }
    catch (err) {
        console.error('api/diffcheck error:', err);
        res.status(500).json({ error: 'diffcheck processing failed', details: err.message });
    }
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Server running on port ${port}`));
