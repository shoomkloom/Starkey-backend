const express = require('express');
//@@const multer = require('multer');
const cors = require('cors');
const AgentManager = require('./agent-manager');
require('dotenv').config();
const { BlobServiceClient } = require('@azure/storage-blob');
const { MongoClient } = require('mongodb');
//@@const { parsePdfBufferToMarkdown } = require('./parsePdfBufferToMarkdown');
const { extractPDF } = require('./extract-text-table-info-with-figures-tables-renditions-from-pdf');
const { extractPDFText } = require('./extractPDFText');

// Azure Blob Storage
const blobServiceClient = BlobServiceClient.fromConnectionString(process.env.AZURE_STORAGE_CONNECTION_STRING);
const containerClient = blobServiceClient.getContainerClient('uploads'); // Ensure container exists

// MongoDB (CosmosDB)
const mongoClient = new MongoClient(process.env.AZURE_COSMOSDB_URI);
const db = mongoClient.db(process.env.AZURE_COSMOSDB_DB);
const collection = db.collection(process.env.AZURE_COSMOSDB_COLLECTION);

const app = express();

const upload = multer({ storage: multer.memoryStorage() });

app.use(cors());
app.use(express.json());

//@@const agentAssistant = new AgentAssistant();
//@@const agentResponse = new AgentResponse();
const agentManager = new AgentManager();

app.get('/', (req, res) => {
  res.send(`
    <h2>Machinta.ai Server</h2>
    <h1>Welcome!</h1>
  `);
});

app.post('/api/chat', async (req, res) => {
    const company = req.body.company;
    const sanitizedCompany = company.replace(/[^a-zA-Z0-9-_]/g, '_'); // avoid unsafe chars
    const message = req.body.message;

    let fileObjects = [];
    try {
        const companyFiles = await collection.find({ sanitizedCompany: sanitizedCompany }).toArray();
        fileObjects = companyFiles
        .filter(file => file.openAiFileId) // Only include if openAiFileId exists
        .map(file => ({
            filename: file.filename,
            openAiFileId: file.openAiFileId
        }));
        if (fileObjects.length === 0) {
            return res.status(404).send({ error: `No Files found for company ${company}` });
        }
    }
    catch (error) {
        console.error('Error retrieving company files:', error);
        return res.status(404).send({ error: error });
    }
    
    try {
        //@@const reply = await agentAssistant.chat(sanitizedCompany, message, fileIds);
        const reply = await agentManager.run(sanitizedCompany, message, fileObjects);
        res.send(reply);
    } 
    catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/upload', upload.single('file'), async (req, res) => {
    console.debug(`GET /api/upload invoked with the file: ${req.file.originalname}`);
    if (req.file.size > 20 * 1024 * 1024) {
        return res.status(400).json({ error: 'File exceeds OpenAI 20MB upload limit.' });
    }

    const company = req.body.company;
    const sanitizedCompany = company.replace(/[^a-zA-Z0-9-_]/g, '_'); // avoid unsafe chars

    try {
        const blobName = `${sanitizedCompany}/${req.file.originalname}`;
        const blockBlobClient = containerClient.getBlockBlobClient(blobName);

        //Check if file already exists
        console.info(`Checking if file '${blobName}' exists`);
        try{
            if (await blockBlobClient.exists()) {
                console.error(`file '${blobName}' already exists`);
                return res.status(400).json({ error: 'File already exists' });
            }
        }
        catch (err) {
            console.error('Error checking file existence:', err);
            return res.status(500).json({ error: 'Failed to check file existence', details: err.message });
        }

        // Upload file to OpenAI
        let openAiFileId = null;
        try {
            openAiFileId = await agentManager.uploadFileToOpenAI(req.file, );
        } catch (err) {
            console.error('OpenAI upload error:', err);
            return res.status(500).json({ error: 'Failed to upload file to OpenAI', details: err.message });
        }

        // Upload to Azure Blob Storage
        await blockBlobClient.uploadData(req.file.buffer);

        // Save metadata in CosmosDB
        const metadata = {
            company: company,
            sanitizedCompany: sanitizedCompany,
            filename: req.file.originalname,
            blobPath: blobName,
            openAiFileId: openAiFileId
        };
        await collection.insertOne(metadata);

        res.json({ message: 'Uploaded & saved', path: blobName });
    } 
    catch (err) {
        console.error('Upload error:', err);
        res.status(500).json({ error: 'Upload failed', details: err.message });
    }
});

app.get('/api/pdfcontent/:pdfname', upload.single('file'), async (req, res) => {
    console.debug(`GET /api/pdfcontent/:pdfname invoked with the param: ${req.params.pdfname}`);

    try {
        extractPDF(req.params.pdfname);
        res.send('Successfully extracted PDF content');
    } 
    catch (err) {
        console.error('Upload error:', err);
        res.status(500).send('Failed to extract PDF content: ' + err.message);
    }
});

app.get('/api/pdftext/:pdfname', upload.single('file'), async (req, res) => {
    console.debug(`GET /api/pdftext/:pdfname invoked with the param: ${req.params.pdfname}`);

    try {
        extractPDFText(req.params.pdfname);
        res.send('Successfully extracted PDF text');
    } 
    catch (err) {
        console.error('Upload error:', err);
        res.status(500).send('Failed to extract PDF text: ' + err.message);
    }
});

app.listen(3000, () => console.log('Express server running on http://localhost:3000'));