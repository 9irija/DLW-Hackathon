require('dotenv').config();
const express  = require('express');
const crypto   = require('crypto');
const { buildReviewPayload }            = require('./core/parser');
const { run: orchestrate, startReview, runAgent, finalize } = require('./agents/orchestrator');
const { logEntry, updateDecision }      = require('./core/logger');
const { embed }                         = require('./context/embeddings');
const { storeChunk, retrieveTopChunks } = require('./context/storage');

const app  = express();
const PORT = process.env.PORT || 3001;

app.use(express.json({ limit: '2mb' }));

// In-memory session store for stepped reviews (keyed by sessionId)
const sessions = new Map();

// ─── Helper: build + embed payload ───────────────────────────────────────────

async function buildPayload(code, filePath, diff, workspaceRoot, docs) {
  const sessionId = crypto.randomUUID();
  const payload   = buildReviewPayload(code, filePath, diff);
  payload.sessionId = sessionId;
  if (workspaceRoot) payload.workspaceRoot = workspaceRoot;
  if (Array.isArray(docs) && docs.length) payload.docs = docs;

  for (let i = 0; i < payload.chunks.length; i++) {
    const embedding = await embed(payload.chunks[i]);
    await storeChunk({ sessionId, filePath, chunkIndex: i, content: payload.chunks[i], embedding });
  }
  const queryEmbedding = await embed(code.slice(0, 500));
  payload.context = await retrieveTopChunks(queryEmbedding, { sessionId, topK: 5 });

  return payload;
}

// POST /review  ---------------------------------------------------------------
// Original single-shot endpoint (kept for backwards compatibility)
app.post('/review', async (req, res) => {
  try {
    const { code, filePath, diff, workspaceRoot, docs } = req.body;
    if (!code || !filePath) return res.status(400).json({ error: 'code and filePath are required' });

    const payload = await buildPayload(code, filePath, diff, workspaceRoot, docs);
    const result  = await orchestrate(payload);

    await logEntry({ agentName: 'orchestrator', findings: result, sessionId: payload.sessionId, filePath });
    res.json(result);
  } catch (err) {
    console.error('Review error:', err);
    res.status(500).json({ error: err.message });
  }
});

// POST /review/start  ---------------------------------------------------------
// Step 1: Run Builder. Returns { sessionId, builderResult }.
app.post('/review/start', async (req, res) => {
  try {
    const { code, filePath, diff, workspaceRoot, docs } = req.body;
    if (!code || !filePath) return res.status(400).json({ error: 'code and filePath are required' });

    const payload = await buildPayload(code, filePath, diff, workspaceRoot, docs);

    // Orchestrator runs Builder and produces enriched payload for downstream agents
    const { builderResult, enrichedPayload } = await startReview(payload);

    sessions.set(payload.sessionId, {
      enrichedPayload,
      agentResults: { builder: builderResult },
    });

    res.json({ sessionId: payload.sessionId, builderResult });
  } catch (err) {
    console.error('review/start error:', err);
    res.status(500).json({ error: err.message });
  }
});

// POST /review/next  ----------------------------------------------------------
// Step 2 or 3: Run factchecker, attacker, or skeptic.
// Body: { sessionId, agent: 'factchecker' | 'attacker' | 'skeptic' }
app.post('/review/next', async (req, res) => {
  try {
    const { sessionId, agent } = req.body;
    if (!sessionId || !agent) return res.status(400).json({ error: 'sessionId and agent are required' });

    const session = sessions.get(sessionId);
    if (!session) return res.status(404).json({ error: 'Session not found or expired' });

    // Orchestrator dispatches to the correct downstream agent
    const agentResult = await runAgent(agent, session.enrichedPayload);
    session.agentResults[agent] = agentResult;
    res.json({ sessionId, agent, agentResult });
  } catch (err) {
    console.error('review/next error:', err);
    res.status(500).json({ error: err.message });
  }
});

// POST /review/finalize  ------------------------------------------------------
// Final step: orchestrate all collected agent results → verdict + score.
// Body: { sessionId }
app.post('/review/finalize', async (req, res) => {
  try {
    const { sessionId } = req.body;
    if (!sessionId) return res.status(400).json({ error: 'sessionId is required' });

    const session = sessions.get(sessionId);
    if (!session) return res.status(404).json({ error: 'Session not found or expired' });

    const result = await finalize(session.agentResults, session.enrichedPayload);
    await logEntry({ agentName: 'orchestrator', findings: result, sessionId, filePath: session.enrichedPayload.filePath });

    sessions.delete(sessionId); // clean up
    res.json(result);
  } catch (err) {
    console.error('review/finalize error:', err);
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

// GET /  —  friendly response when opening backend URL in browser
app.get('/', (_req, res) => {
  res.type('html').send(`
    <h1>Code Review Backend</h1>
    <p>Server is running. This is an API server for the VS Code extension.</p>
    <ul>
      <li><a href="/health">GET /health</a> — liveness check</li>
      <li>POST /review — run code review (called by extension)</li>
      <li>POST /decision — record human decision</li>
    </ul>
  `);
});

// GET /health  ----------------------------------------------------------------
app.get('/health', (_req, res) => res.json({ status: 'ok', timestamp: new Date().toISOString() }));

// Try PORT, then PORT+1, ... up to PORT+9 if port is in use
function tryListen(port, maxTries = 10) {
  const server = app.listen(port, () => {
    console.log(`Code review backend listening on http://localhost:${port}`);
  });
  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE' && maxTries > 1) {
      tryListen(port + 1, maxTries - 1);
    } else {
      console.error('Cannot start server:', err.message);
      process.exit(1);
    }
  });
}

tryListen(Number(PORT));

module.exports = app;
