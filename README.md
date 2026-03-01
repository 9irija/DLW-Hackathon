# Multi-Agent AI Code Review — VS Code Extension

Four specialized AI agents review your code in parallel, then an orchestrator
synthesizes their findings into a single scored verdict.

---

## Folder Structure

```
RunChecks/
├── backend/
│   ├── agents/
│   │   ├── factchecker.js   # Verifies comments match implementation
│   │   ├── attacker.js      # Hunts security vulnerabilities (+ CWE IDs)
│   │   ├── skeptic.js       # Challenges assumptions, scores confidence 0–100
│   │   ├── builder.js       # Suggests improvements and patterns
│   │   └── orchestrator.js  # Runs all 4 in parallel, issues verdict
│   ├── core/
│   │   ├── openai.js        # Shared OpenAI client (reads OPENAI_API_KEY)
│   │   ├── parser.js        # chunkCode, detectLanguage, buildReviewPayload
│   │   └── logger.js        # SQLite audit_log table
│   ├── context/
│   │   ├── embeddings.js    # embed() via text-embedding-3-small + cosineSimilarity
│   │   └── storage.js       # storeChunk, retrieveTopChunks (top-5), clearSession
│   ├── shadow/
│   │   └── runner.js        # Isolated child_process snippet executor
│   ├── index.js             # Express: POST /review, POST /decision, GET /health
│   ├── .env.example
│   └── package.json
│
└── frontend/
    ├── src/
    │   ├── extension.js          # activate(), 4 commands, auto-review on save
    │   ├── panels/
    │   │   ├── agentStatus.js    # Sidebar tree: per-agent status
    │   │   ├── findings.js       # Webview: findings table
    │   │   ├── verdict.js        # Sidebar tree: verdict + score
    │   │   └── skepticCharts.js  # Webview: Chart.js bar + radar
    │   └── webviews/
    │       ├── findings.html
    │       └── charts.html
    └── package.json
```

---

## Agents

| Agent | Role |
|---|---|
| **factchecker** | Are comments accurate? |
| **attacker**    | Security vulnerabilities with CWE mappings |
| **skeptic**     | Assumptions, edge cases, 0–100 confidence scores |
| **builder**     | Constructive improvements with code examples |
| **orchestrator**| Merges all → `approve / request-changes / block` + score |

---

## Getting Started

### Backend

```bash
cd backend
cp .env.example .env   # add your OPENAI_API_KEY
npm install
npm start              # http://localhost:3001
```

### Frontend (VS Code Extension)

```bash
cd frontend
npm install
# Open frontend/ in VS Code, press F5 to launch Extension Development Host
```

---

## API

| Endpoint | Method | Purpose |
|---|---|---|
| `/review`   | POST | Run full multi-agent review |
| `/decision` | POST | Record human accept/reject/defer on a logged review |
| `/health`   | GET  | Liveness check |

### POST /review body
```json
{ "code": "...", "filePath": "src/foo.js", "diff": "optional unified diff" }
```

---

## VS Code Commands

| Command | What it does |
|---|---|
| `Code Review: Review Current File` | Reviews the active editor |
| `Code Review: Review Selection`    | Reviews highlighted text only |
| `Code Review: Show Findings`       | Opens findings webview |
| `Code Review: Show Skeptic Charts` | Opens Chart.js confidence charts |

**Settings:** `codeReview.backendUrl` (default `http://localhost:3001`), `codeReview.autoReviewOnSave` (default `false`).

---

## Data (SQLite — `backend/data/audit.db`)

| Table | Columns |
|---|---|
| `audit_log`       | id, timestamp, agent_name, findings, human_decision, session_id, file_path |
| `document_chunks` | id, session_id, file_path, chunk_index, content, embedding |
