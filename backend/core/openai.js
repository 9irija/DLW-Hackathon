require('dotenv').config();
const OpenAI = require('openai');

if (!process.env.OPENAI_API_KEY) {
  throw new Error('OPENAI_API_KEY is not set. Copy .env.example to .env and add your key.');
}

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

module.exports = openai;
