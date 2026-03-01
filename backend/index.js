require('dotenv').config();
const express  = require('express');
const crypto   = require('crypto');
const { buildReviewPayload }            = require('./core/parser');
const { run: orchestrate }              = require('./agents/orchestrator');
const { logEntry, updateDecision }      = require('./core/logger');
const { embed }                         = require('./context/embeddings');
const { storeChunk, retrieveTopChunks } = require('./context/storage');

const app  = express();
const PORT = process.env.PORT || 3001;

app.use(express.json({ limit: '2mb' }));

// POST /review  ---------------------------------------------------------------
app.post('/review', async (req, res) => {
  try {
    const { code, filePath, diff, workspaceRoot, docs } = req.body;
    if (!code || !filePath) return res.status(400).json({ error: 'code and filePath are required' });

    const sessionId = crypto.randomUUID();
    const payload   = buildReviewPayload(code, filePath, diff);
    payload.sessionId = sessionId;
    if (workspaceRoot) payload.workspaceRoot = workspaceRoot;
    // docs: [{ name, content }] — passed to factchecker for external doc review
    if (Array.isArray(docs) && docs.length) payload.docs = docs;

    // Embed each chunk and store in the RAG vector store
    for (let i = 0; i < payload.chunks.length; i++) {
      const embedding = await embed(payload.chunks[i]);
      await storeChunk({ sessionId, filePath, chunkIndex: i, content: payload.chunks[i], embedding });
    }

    // Attach top-5 relevant chunks as context
    const queryEmbedding = await embed(code.slice(0, 500));
    payload.context = await retrieveTopChunks(queryEmbedding, { sessionId, topK: 5 });

    const result = await orchestrate(payload);

    await logEntry({ agentName: 'orchestrator', findings: result, sessionId, filePath });

    res.json(result);
  } catch (err) {
    console.error('Review error:', err);
    res.status(500).json({ error: err.message });
  }
});

// POST /decision  -------------------------------------------------------------
app.post('/decision', async (req, res) => {
  try {
    const { logId, decision } = req.body;
    if (!logId || !decision) return res.status(400).json({ error: 'logId and decision are required' });
    await updateDecision(logId, decision);
    res.json({ ok: true });
  } catch (err) {
    console.error('Decision error:', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /health  ----------------------------------------------------------------
app.get('/health', (_req, res) => res.json({ status: 'ok', timestamp: new Date().toISOString() }));

app.listen(PORT, () => console.log(`Code review backend listening on http://localhost:${PORT}`));

module.exports = app;
