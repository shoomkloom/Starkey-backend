const fs = require('fs');
const path = require('path');
const { OpenAI } = require('openai');
require('dotenv').config({ quiet: true });
const { searchSimilarClientSide } = require('./embeddings');
const { connectToMongo } = require('./db');
const { getParams } = require('./sysparams');
const { setEmbeddingsOpenAIClient } = require('./embeddings');

class AgentResponse {
    constructor() {
        this.openai = new OpenAI({ apiKey: process.env.OPENAI_KEY });
        setEmbeddingsOpenAIClient(this.openai);
        this.vectorStoreId = null;
        this.messageHistory = [];

        this.systemPrompt = `You are a Professor of Neurology & Medicine, specializing in Cognitive & Motor Aging and Geriatrics.
                            When a user asks a question or gives a prompt, follow these rules:
                            1. Consider all available document content and the additional web content.
                            2. If your answer is based on the content of the files or additional web content, **always** provide excerpts with sources.
                            3. If your answer is **not** based on the content of the files or additional web content, provide an excerpt with the source being: "OpenAI Training Data".
                            4. Use all the data available in the files and web content.If information is missing or ambiguous, tell the user that the answer was not found in the uploaded content.
                            5. If the question is off topic, answer in a congenial way and suggest asking more relevant questions.
                            6. The final answer should be **only** with a valid JSON object in this format:
                            { "summary": ..., "excerpts": [{"excerpt":..., "source":...}] }
                            containing:
                            - "summary": a concise and clear answer to the question based on relevant material you found in the files.
                            - "excerpts": an array of objects per each file found:
                                - "excerpt": a short extract from the file that is relevant to the question on which the answer is based.
                                - "source": the file name or web page title where you found the excerpt. `;

        console.debug(`--> AgentResponse Started <<--`);
    }

    async processFile(file) {
        console.debug(`processFile(.) involed.`);
        if(!this.vectorStoreId) {
            const vectorStore = await this.openai.vectorStores.create({name: "Starkey",});
            this.vectorStoreId = vectorStore.id;
        }

        // Save file to a local folder
        // This is just for demonstration purposes, in production you would use a cloud storage service
        const folderPath = path.join(__dirname, 'filedata');
        if (!fs.existsSync(folderPath)) {
            fs.mkdirSync(folderPath);
        }
        const localFilePath = path.join(folderPath, file.originalname);
        fs.writeFileSync(localFilePath, file.buffer);
        console.log(`File saved locally to ${localFilePath}`);

        // Upload file to OpenAI
        const uploadedFile = await this.openai.files.create({
            file: fs.createReadStream(localFilePath),
            purpose: "assistants",
        });

        await this.openai.vectorStores.files.createAndPoll(
            this.vectorStoreId,
            { file_id: uploadedFile.id }
        );

        // Save metadata in MongoDB
        const db = await connectToMongo();
        const collection = db.collection('files');
        const existingDoc = await collection.findOne({ filename: file.originalname });
        if(!existingDoc) {
            const metadata = {
                filename: file.originalname,
                savePath: localFilePath,
                openAiFileId: uploadedFile.id
            };
            await collection.insertOne(metadata);
        }
        else{
            console.log(`File already saved locally to ${localFilePath}`);
        }

        return localFilePath;
    }

    async run(userPrompt) {
        const { historyLength, modelName, temperature, numTopFiles, numTopLinks } = getParams();
        
        let fileObjects = [];
        try {
            const db = await connectToMongo();
            const collection = db.collection('files');
            fileObjects = (await collection.find().toArray())
            .filter(file => file.openAiFileId) // Only include if openAiFileId exists
            .map(file => ({
                filename: file.filename,
                openAiFileId: file.openAiFileId
            }));
            if (fileObjects.length === 0) {
                console.warn('No Files found');
            }
        }
        catch (error) {
            console.error('Error retrieving files:', error);
            return res.status(404).send({ error: error });
        }
        
        //Add existing files to vector store
        if(!this.vectorStoreId) {
            const vectorStore = await this.openai.vectorStores.create({name: 'Starkey',});
            this.vectorStoreId = vectorStore.id;
        }

        const fileIds = this.extractFileIds(fileObjects);

        // Ensure the vector store is in sync with the provided file IDs
        this.syncVectorStoreWithFileIds(fileIds);

        this.messageHistory.push({ role: 'user', content: userPrompt });
        if(this.messageHistory.length > historyLength) {
            this.messageHistory.shift(); // Keep the last historyLength messages
        }
        console.info("--> YOU:", userPrompt);

        // Search for similar chunks in the vector store
        const db = await connectToMongo();
        const collection = db.collection('links');
        const retrievedChunks = await searchSimilarClientSide(userPrompt, collection, numTopLinks);
        const webContext = retrievedChunks.map(c => `Text: ${c.text}\nSource: ${c.title} (${c.url})`).join('\n---\n');

        //Construct messages
        const inputMessages = [
            ...this.messageHistory, // historical conversation
            {
                role: "user",
                content: `Additional web content to use in your answer if relevant:\n\n${webContext}\n\nQuestion: ${userPrompt}`
            }
        ];

        //Call OpenAI agent with both custom context and file_search tool
        const response = await this.openai.responses.create({
            model: modelName,
            instructions: this.systemPrompt,
            tools: [
                {
                    type: "file_search",
                    vector_store_ids: [this.vectorStoreId],
                    max_num_results: numTopFiles
                }
            ],
            include: ["file_search_call.results"],
            input: inputMessages,
            temperature: temperature
        });

        // Retrieve the latest message
        const extracted = this.extractJsonText(response.output_text);
        console.info("-->> OPEN AI:", extracted);

        const extractedJson = JSON.parse(extracted);
        this.messageHistory.push({ role: 'assistant', content: extractedJson.summary });

        return extracted;
    }

    extractFileIds(data) {
        if (Array.isArray(data)) {
            return data
            .map(item => item.file_id)
            .filter(id => !!id); // filters out undefined/null
        } else if (data && typeof data === 'object' && 'file_id' in data) {
            return [data.file_id];
        }
        return [];
    }

    extractJsonText(text) {
        const firstBrace = text.indexOf('{');
        const lastBrace = text.lastIndexOf('}');

        if (firstBrace === -1 || lastBrace === -1 || firstBrace > lastBrace) {
            return null;
        }

        return text.substring(firstBrace, lastBrace + 1);
    }

    async syncVectorStoreWithFileIds(desiredFileIds) {
        const currentFiles = await this.openai.vectorStores.files.list(this.vectorStoreId);
        const currentFileIds = currentFiles.data.map(f => f.id);

        const toAdd = desiredFileIds.filter(id => !currentFileIds.includes(id));

        for (const fileId of toAdd) {
            await this.openai.vectorStores.files.createAndPoll(
                this.vectorStoreId, 
                { file_id: fileId }
            );
        }
        console.info(`Added ${toAdd.length} new files to vector store from ${desiredFileIds.length} existing files.`);
    }
}

// Export the class
module.exports = AgentResponse;

