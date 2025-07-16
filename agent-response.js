const fs = require('fs');
const path = require('path');
const os = require('os');
const { OpenAI } = require('openai');
require('dotenv').config({ quiet: true });
const { searchSimilarClientSide } = require('./embeddings');
const { connectToMongo } = require('./db');

class AgentResponse {
    constructor() {
        this.openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
        this.vectorStoreId = null;
        this.messageHistory = [];

        this.systemPrompt = `You are a Professor of Neurology & Medicine, specializing in Cognitive & Motor Aging and Geriatrics.
                            When a user asks a question or gives a prompt, follow these rules:
                            1. Consider all available documents and their content and the additional web content.
                            2. Use all the data available in the files and web content.If information is missing or ambiguous, tell the user that the answer was not found in the uploaded content.
                            3. If the question is off topic, answer in a congenial way and suggest asking more relevant questions.
                            4. The final answer should be **only** with a valid JSON object in this format:
                            { "summary": ..., "excerpts": [{"excerpt":..., "source":...}] }
                            containing:
                            - "summary": a concise and clear answer to the question based on relevant material you found in the files.
                            - "excerpts": an array of objects per each file found:
                                - "excerpt": a short extract from the file that is relevant to the question on which the answer is based.
                                - "source": the file name or web page title where you found the excerpt. `;
    }

    async uploadFileToOpenAI(file) {
        console.debug(`uploadFileToOpenAI(.) involed.`);
        if(!this.vectorStoreId) {
            const vectorStore = await this.openai.vectorStores.create({name: "Starkey",});
            this.vectorStoreId = vectorStore.id;
        }

        const tempPath = path.join(os.tmpdir(), file.originalname);
        fs.writeFileSync(tempPath, file.buffer); // write the file content to disk
        const uploadedFile = await this.openai.files.create({
            file: fs.createReadStream(tempPath),
            purpose: "assistants",
        });

        await this.openai.vectorStores.files.createAndPoll(
            this.vectorStoreId,
            { file_id: uploadedFile.id }
        );

        return uploadedFile.id; // return the OpenAI file ID
    }

    async run(userPrompt, fileObjects) {
        //Add existing files to vector store
        if(!this.vectorStoreId) {
            const vectorStore = await this.openai.vectorStores.create({name: 'Starkey',});
            this.vectorStoreId = vectorStore.id;
        }

        const fileIds = this.extractFileIds(fileObjects);

        // Ensure the vector store is in sync with the provided file IDs
        this.syncVectorStoreWithFileIds(fileIds);

        this.messageHistory.push({ role: 'user', content: userPrompt });
        if(this.messageHistory.length > 10) {
            this.messageHistory.shift(); // Keep the last 10 messages
        }
        console.info("--> YOU:", userPrompt);

        // Search for similar chunks in the vector store
        const db = await connectToMongo();
        const collection = db.collection('links');
        const retrievedChunks = await searchSimilarClientSide(userPrompt, collection);
        const webContext = retrievedChunks.map(c => `Source: ${c.title} (${c.url})\nText: ${c.text}`).join('\n---\n');

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
            model: "gpt-4o",
            instructions: this.systemPrompt, // optional; already included in messages
            tools: [
                {
                    type: "file_search",
                    vector_store_ids: [this.vectorStoreId],
                    max_num_results: 20
                }
            ],
            include: ["file_search_call.results"],
            input: inputMessages,
            temperature: 0.2
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
        console.info(`Added ${toAdd.length} new files to vector store`);
    }
}

// Export the class
module.exports = AgentResponse;

