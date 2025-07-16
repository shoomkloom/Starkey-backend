const fs = require('fs');
const path = require('path');
const os = require('os');
const { OpenAI } = require('openai');
require('dotenv').config({ quiet: true });

class AgentResponse {
    constructor() {
        this.openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
        this.vectorStoreId = null;
        this.currentInput = '';

        this.systemPrompt = `You are a Professor of Neurology & Medicine, specializing in Cognitive & Motor Aging and Geriatrics.
                            When a user asks a question or gives a prompt, follow these rules:
                            1. Consider all available documents.
                            2. Use the data in the files first, and if information is missing or ambiguous, say so in the response.
                            3. If the question is off topic, answer in a gongenial way and suggest asking more on topic questions.
                            4. The final answer should be **only** with a valid JSON object in this format:
                            { "summary": ..., [{"excerpt":..., "file":...}] }
                            containing:
                            - "summary": a concise and clear answer to the question based on relevant material you found in the files.
                            - an array of objects per each file found:
                                - "excerpt": a short extract from the file that is relevant to the question on which the answer is based.
                                - "file": the file name where you found the excerpt. `;
    }

    async run(userPrompt, fileObjects) {
        //Add existing files to vector store
        if(!this.vectorStoreId) {
            const vectorStore = await this.openai.vectorStores.create({name: companyName,});
            this.vectorStoreId = vectorStore.id;
        }

        //@@const fileNames = this.extractFileNames(fileObjects);
        const fileIds = this.extractFileIds(fileObjects);

        // Ensure the vector store is in sync with the provided file IDs
        this.syncVectorStoreWithFileIds(fileIds);

        this.currentInput += `${userPrompt}`;
        console.info("YOU:", userPrompt);

        //Call OpenAI API to create the response
        const response = await this.openai.responses.create({
            model: "gpt-4o",
            instructions: this.systemPrompt,
            tools: [{
                type: "file_search",
                vector_store_ids: [this.vectorStoreId],
                max_num_results: 20
            }],
            input: currentInput,
            temperature: 0.2,
        });
  
        // Retrieve the latest message
        const extracted = extractJsonText(response.output_text);
        console.info("-->> OPEN AI:", extracted);

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

/*@@    
    extractFileNames(data) {
        if (Array.isArray(data)) {
            return data
            .map(item => item.file_name)
            .filter(name => !!name); // filters out undefined/null
        } else if (data && typeof data === 'object' && 'file_name' in data) {
            return [data.file_name];
        }
        return [];
    }
@@*/
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

