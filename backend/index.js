require('dotenv').config();
const express = require('express');
const crypto = require('crypto');
const { buildReviewPayload } = require('./core/parser');
const {
  run: orchestrate,
  runBuilder,
  runAgent,
  buildEnrichedPayload,
  finalize,
} = require('./agents/orchestrator');
const { logEntry, updateDecision } = require('./core/logger');
const { embed } = require('./context/embeddings');
const { storeChunk, retrieveTopChunks } = require('./context/storage');

const app = express();
const PORT = process.env.PORT || 3001;

const REVIEW_SESSIONS = new Map();
const SESSION_TTL_MS = 60 * 60 * 1000;

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

function cleanupSessions() {
  const now = Date.now();
  for (const [sessionId, session] of REVIEW_SESSIONS.entries()) {
    if (now - session.createdAt > SESSION_TTL_MS) REVIEW_SESSIONS.delete(sessionId);
  }
}

function summarizeAgent(agentName, result) {
  const findings = result?.findings || [];
  const counts = { critical: 0, high: 0, medium: 0, low: 0 };
  findings.forEach(f => {
    const sev = ['critical', 'high', 'medium', 'low'].includes(f.severity) ? f.severity : 'low';
    counts[sev] += 1;
  });

  return {
    agent: agentName,
    status: result?.status || 'unknown',
    summary: result?.summary || '',
    findingsCount: findings.length,
    severityBreakdown: counts,
  };
}

async function buildSessionPayload({ code, filePath, diff, workspaceRoot, docs }, sessionId) {
  const payload = buildReviewPayload(code, filePath, diff);
  payload.sessionId = sessionId;
  if (workspaceRoot) payload.workspaceRoot = workspaceRoot;
  if (Array.isArray(docs) && docs.length) payload.docs = docs;

  for (let i = 0; i < payload.chunks.length; i += 1) {
    const embedding = await embed(payload.chunks[i]);
    await storeChunk({
      sessionId,
      filePath,
      chunkIndex: i,
      content: payload.chunks[i],
      embedding,
    });
  }

  const queryEmbedding = await embed(code.slice(0, 500));
  payload.context = await retrieveTopChunks(queryEmbedding, { sessionId, topK: 5 });

  return payload;
}

// POST /review/start -----------------------------------------------------------
app.post('/review/start', async (req, res) => {
  try {
    cleanupSessions();

    const { code, filePath } = req.body;
    if (!code || !filePath) return res.status(400).json({ error: 'code and filePath are required' });

    const sessionId = crypto.randomUUID();
    const payload = await buildSessionPayload(req.body, sessionId);

    const reasonerResult  = await runBuilder(payload);
    const enrichedPayload = buildEnrichedPayload(payload, reasonerResult);

    REVIEW_SESSIONS.set(sessionId, {
      createdAt: Date.now(),
      sessionId,
      payload,
      enrichedPayload,
      filePath,
      agentResults: { reasoner: reasonerResult },
      lastCompletedAgent: 'reasoner',
    });

    const partialReview = await finalize({ reasoner: reasonerResult }, payload);

    return res.json({
      sessionId,
      stage: 'reasoner-complete',
      nextAgent: 'factchecker',
      reasonerResult,
      partialReview,
      checkpoint: {
        type: 'reasoner',
        requiresApproval: false,
        message: 'Pre-processing complete. Proceed to factchecker.',
      },
    });
  } catch (err) {
    console.error('Review start error:', err);
    return res.status(500).json({ error: err.message });
  }
});

// POST /review/next ------------------------------------------------------------
app.post('/review/next', async (req, res) => {
  try {
    cleanupSessions();

    const { sessionId, agent } = req.body;
    if (!sessionId || !agent) return res.status(400).json({ error: 'sessionId and agent are required' });

    const session = REVIEW_SESSIONS.get(sessionId);
    if (!session) return res.status(404).json({ error: 'Review session not found or expired' });

    if (!['factchecker', 'attacker', 'skeptic'].includes(agent)) {
      return res.status(400).json({ error: 'agent must be one of factchecker, attacker, skeptic' });
    }

    if (agent === 'attacker' && !session.agentResults.factchecker) {
      return res.status(409).json({ error: 'factchecker must run before attacker' });
    }
    if (agent === 'skeptic' && !session.agentResults.attacker) {
      return res.status(409).json({ error: 'attacker must run before skeptic' });
    }
    if (session.agentResults[agent]) {
      return res.status(409).json({ error: `${agent} has already run for this session` });
    }

    const agentResult = await runAgent(agent, session.enrichedPayload);
    session.agentResults[agent] = agentResult;
    session.lastCompletedAgent = agent;

    const partialReview = await finalize(session.agentResults, session.payload);

    const checkpoint = {
      type: agent,
      requiresApproval: agent === 'factchecker' || agent === 'attacker',
      message:
        agent === 'factchecker'
          ? 'Factchecker completed. Approve to continue to attacker, or stop and make changes.'
          : agent === 'attacker'
            ? 'Attacker completed. Approve to continue to testing choice, or stop and make changes.'
            : 'Skeptic completed. Ready to finalize verdict.',
      nextAgent:
        agent === 'factchecker'
          ? 'attacker'
          : agent === 'attacker'
            ? 'skeptic (optional)'
            : null,
    };

    return res.json({
      sessionId,
      ranAgent: agent,
      agentSummary: summarizeAgent(agent, agentResult),
      agentResult,
      checkpoint,
      partialReview,
    });
  } catch (err) {
    console.error('Review next error:', err);
    return res.status(500).json({ error: err.message });
  }
});

// POST /review/finalize --------------------------------------------------------
app.post('/review/finalize', async (req, res) => {
  try {
    cleanupSessions();

    const { sessionId, testingMode = 'user' } = req.body;
    if (!sessionId) return res.status(400).json({ error: 'sessionId is required' });

    const session = REVIEW_SESSIONS.get(sessionId);
    if (!session) return res.status(404).json({ error: 'Review session not found or expired' });

    const finalResult = await finalize(session.agentResults, session.payload);
    finalResult.testingMode = testingMode;

    await logEntry({
      agentName: 'orchestrator',
      findings: finalResult,
      sessionId,
      filePath: session.filePath,
    });

    REVIEW_SESSIONS.delete(sessionId);

    return res.json(finalResult);
  } catch (err) {
    console.error('Review finalize error:', err);
    return res.status(500).json({ error: err.message });
  }
});

// POST /review (single-shot, backwards compatible) -----------------------------
app.post('/review', async (req, res) => {
  try {
    cleanupSessions();

    const { code, filePath } = req.body;
    if (!code || !filePath) return res.status(400).json({ error: 'code and filePath are required' });

    const sessionId = crypto.randomUUID();
    const payload = await buildSessionPayload(req.body, sessionId);
    const result = await orchestrate(payload);

    await logEntry({ agentName: 'orchestrator', findings: result, sessionId, filePath });

    return res.json(result);
  } catch (err) {
    console.error('Review error:', err);
    return res.status(500).json({ error: err.message });
  }
});

// POST /decision ---------------------------------------------------------------
app.post('/decision', async (req, res) => {
  try {
    const { logId, decision } = req.body;
    if (!logId || !decision) return res.status(400).json({ error: 'logId and decision are required' });
    await updateDecision(logId, decision);
    return res.json({ ok: true });
  } catch (err) {
    console.error('Decision error:', err);
    return res.status(500).json({ error: err.message });
  }
});

// GET / ------------------------------------------------------------------------
app.get('/', (_req, res) => {
  res.type('html').send(`
    <h1>Code Review Backend</h1>
    <p>Server is running. This is an API server for the VS Code extension.</p>
    <ul>
      <li><a href="/health">GET /health</a> - liveness check</li>
      <li>POST /review/start - run builder and open stepped session</li>
      <li>POST /review/next - run next stepped agent</li>
      <li>POST /review/finalize - compute verdict from stepped session</li>
      <li>POST /review - single-shot full review (backwards compatible)</li>
      <li>POST /decision - record human decision</li>
    </ul>
  `);
});

// GET /health ------------------------------------------------------------------
app.get('/health', (_req, res) => res.json({ status: 'ok', timestamp: new Date().toISOString() }));

function tryListen(port, maxTries = 10) {
  const server = app.listen(port, () => {
    console.log(`Code review backend listening on http://localhost:${port}`);
  });
  server.on('error', err => {
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
