const fs = require('fs');
const path = require('path');
const os = require('os');
const { OpenAI } = require('openai');
const { extractJsonText } = require('./helpers');
require('dotenv').config();

class AgentResponse {
    constructor() {
        this.openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
        this.vectorStoreId = null;

        this.systemPrompt = `You are a senior business analyst and financial expert specializing in analyzing corporate documents, including Profit & Loss reports, Share Purchase Agreements, Employment Agreements, and Board Resolutions. You have access to internal documents of a company and your goal is to extract actionable items to fix and structured insights that are relevant for founders, CFOs, and investors.
                    When a user asks a question or gives a prompt, follow these rules:
                    1. Consider all available documents and compare them to industry benchmarks where appropriate.
                    2. Use the data in the files first, and if information is missing or ambiguous, make intelligent assumptions based on typical market data for similar sized companies.
                    3. If your answer is not baesd on the files, say so in the explanation.
                    4. The final answer should be **only** with a valid JSON object in this format:
                    { "company_name": ..., "explanation": ..., "positive: ..., "negative", ...", "insights": [...], "fixitems": [...] }
                    containing:
                    - 'company_name': inferred or mentioned in the context
                    - 'explanation': a short summary of the analysis or reasoning behind the insights. Add the list of files used to answer the question.
                    - 'positive': a positive aspect if exists, based on the files relative to other similar companies. If the data is worse than the industry benchmark, leave this blank.
                    - 'negative': a negative aspect if exists, based on the files relative to other similar companies. If the data is better than the industry benchmark, leave this blank.
                    - 'insights': array of 4 of the best answers that are directly related to the question, based on all the files with:
                        - type: one of ['amount', 'range', 'text', 'percent']
                        - name: a short title (e.g. 'base salary', 'equity range')
                        - value: a short recommended value (e.g. '$130K', '0.5% - 1%')
                    - 'fixitems': array of up to 10 items (at least 4) that answer the question: 'What to fix next?' with:
                        - type: one of ['alert', 'rate', 'ratio', 'time']
                        - name: a short label (e.g. 'Burn Rate', 'CAC Payback')
                        - value: a sentence or phrase describing the action to take (e.g. 'Reduce burn rate to 12 months runway', 'Improve CAC payback to 6 months')
                    5. Always be concise, structured, and actionable. insight values should be short and to the point.
                    6. If information is missing or ambiguous, make intelligent assumptions based on typical market data for similar sized company.
                    7. Do not include any additional explanation outside the JSON response.`;
    }

    async run(companyName, userPrompt, fileObjects) {
        //Add existing files to vector store
        if(!this.vectorStoreId) {
            const vectorStore = await this.openai.vectorStores.create({name: companyName,});
            this.vectorStoreId = vectorStore.id;
        }

        const fileNames = this.extractFileNames(fileObjects);
        const fileIds = this.extractFileIds(fileObjects);

        // Ensure the vector store is in sync with the provided file IDs
        this.syncVectorStoreWithFileIds(fileIds);

        const currentInput = `Company: ${companyName}\n\n${userPrompt}\n\nFiles:\n${fileNames.map((name) => `- ${name}`).join(',')}`;
        console.info("YOU:", currentInput);

        //Call OpenAI API to create the response
        const response = await this.openai.responses.create({
            model: "gpt-4o-mini",
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

    async syncVectorStoreWithFileIds(desiredFileIds) {
        const currentFiles = await this.openai.vectorStores.files.list(this.vectorStoreId);
        const currentFileIds = currentFiles.data.map(f => f.id);

        const toAdd = desiredFileIds.filter(id => !currentFileIds.includes(id));
        const toRemove = currentFileIds.filter(id => !desiredFileIds.includes(id));

        for (const fileId of toAdd) {
            await this.openai.vectorStores.files.createAndPoll(
                this.vectorStoreId, 
                { file_id: fileId }
            );
        }
        console.info(`Added ${toAdd.length} new files to vector store`);

        for (const fileId of toRemove) {
            await this.openai.vectorStores.files.del(this.vectorStoreId, fileId);
            console.info(`Removed file ${fileId} from vector store`);
        }
        console.info(`Removed ${toRemove.length} files from vector store`);
    }
}

// Create instance
const responseInstance = new AgentResponse();

// Export tool definition
const responseToolDefinition = {
    name: 'generate_structured_response',
    description: 'Analyzes relevant files and returns a structured business JSON report based on a user question.',
    inputSchema: {
        type: 'object',
        properties: {
            companyName: { type: 'string', description: 'The name of the company being analyzed.' },
            userPrompt: { type: 'string', description: 'The user’s question or goal.' },
            fileObjects: {
                type: 'array',
                description: 'List of files with name and file ID',
                items: {
                    type: 'object',
                    properties: {
                        file_name: { type: 'string' },
                        file_id: { type: 'string' }
                    },
                    required: ['file_name', 'file_id']
                }
            }
        },
        required: ['companyName', 'userPrompt', 'fileIds']
    },
    function: async ({ companyName, userPrompt, fileObjects }) => {
        return await responseInstance.run(companyName, userPrompt, fileObjects);
    }
};

// Export both the class and tool definition
module.exports = {
    AgentResponse,
    responseToolDefinition
};

