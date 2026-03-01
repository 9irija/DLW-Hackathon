# Multi-Agent AI Code Review — VS Code Extension

Four specialized AI agents review your code with **human verification at every stage**. The orchestrator manages the full pipeline and synthesizes findings into a scored verdict: `approve / request-changes / block`.

---

## Human-in-the-Loop Review Flow

The key feature of this extension is **three human checkpoints** built into the review pipeline. Each agent runs one at a time and pauses for your decision before proceeding.

```
[VS Code Extension — runReviewStepped()]
        │
        │  POST /review/start
        ▼
[Orchestrator — startReview()]
  Runs Builder → enriches payload with codeContext
        │
        ▼
  [CHECKPOINT 1] ── "Potential risks: X. Continue to Factchecker?"
                        Approve & Continue  ──►  POST /review/next (factchecker)
                        Stop Review         ──►  POST /review/finalize → partial verdict
        │
        │  POST /review/next { agent: 'factchecker' }
        ▼
[Orchestrator — runAgent('factchecker')]
  Factchecker runs (inline + doc passes) → findings shown in panel
        │
        ▼
  [CHECKPOINT 2] ── "N finding(s) found. Continue to Security Scan?"
                        Approve & Continue  ──►  POST /review/next (attacker)
                        Stop & Get Verdict  ──►  POST /review/finalize → partial verdict
        │
        │  POST /review/next { agent: 'attacker' }
        ▼
[Orchestrator — runAgent('attacker')]
  Attacker runs (3-step exploit pipeline) → findings shown in panel
        │
        ▼
  [CHECKPOINT 3] ── "N vulnerabilities found. Run Skeptic for enhanced review?"
                        Yes — Run Skeptic  ──►  POST /review/next (skeptic)
                                                then POST /review/finalize
                        No — Get Verdict   ──►  POST /review/finalize (without skeptic)
        │
        ▼
[Orchestrator — finalize()]
  Normalise + deduplicate all findings
  Builder challenge loop (critical findings only)
  Score + verdict + summary → response
        │
        ▼
[Frontend panels update: Findings, Charts, Agent Status, Verdict]
```

> Stopping early at any checkpoint still produces a full scored verdict based on the agents that ran.

---

## How It Works — Full Pipeline Detail

```
[VS Code Extension]
        │  POST /review/start  { code, filePath, language, workspaceRoot, docs? }
        ▼
[Express Backend — index.js]  (thin HTTP layer)
  • Detect language, chunk code (1 500-char chunks, 200-char overlap)
  • Embed each chunk via text-embedding-3-small → store in SQLite (RAG)
  • Retrieve top-5 similar chunks from previous sessions as context
  • Delegates all agent execution to Orchestrator
        │
        ▼
[Orchestrator — orchestrator.js]  (sole agent manager)
        │
        ├─ startReview() ── Builder (gpt-5-codex, always first)
        │    Analyses intent, entry points, dependencies, data flows,
        │    external calls, side effects, and preliminary risks.
        │    → Produces codeContext used to enrich all downstream prompts.
        │
        ├─ runAgent('factchecker') ── Factchecker (gpt-5-codex) — TWO PASSES
        │    │    Pass 1 — Inline: compares every comment/docstring in the
        │    │             code against what the code actually does.
        │    │             Findings tagged with line number.
        │    │    Pass 2 — Docs (only when docs[] provided): compares each
        │    │             external document (README, API spec, design doc)
        │    │             against the actual implementation.
        │    │             Findings tagged with docSource (filename).
        │    │
        ├─ runAgent('attacker') ── Attacker (gpt-5-codex + gpt-5.1-codex-mini + shadow/runner)
        │    │    Step 1 — Static scan (gpt-5-codex): finds vulnerabilities,
        │    │             maps to CWE IDs, rates severity, describes impact.
        │    │    Step 2 — PoC generation (gpt-5.1-codex-mini, high/critical only):
        │    │             writes a self-contained Node.js exploit script that
        │    │             mocks the vulnerable logic and crafts a malicious input.
        │    │    Step 3 — Shadow execution (child_process, 5 s timeout):
        │    │             if the PoC exits 0 and prints "CONFIRMED",
        │    │             exploitProof.confirmed = true.
        │    │
        ├─ runAgent('skeptic') ── Skeptic (shadow/runner + flowParser) [optional]
        │         Runs the code (or full test suite if workspaceRoot provided)
        │         in an isolated child_process. Builds evidence charts:
        │         failure timeline, endpoint heatmap, latency distribution,
        │         user-journey failures. Parses import graph → flow diagram.
        │
        └─ finalize() ── Normalise & deduplicate findings
        │    All agent outputs mapped to a common shape.
        │    Doc findings (line = null) are never deduplicated — all kept.
        │    Same line + same type across agents → keep highest severity.
        │    Sorted: severity desc → confidence desc.
        │
        ├─ PHASE 4 ── Builder challenge loop (critical findings only)
        │    For each critical finding from factchecker or attacker,
        │    builder.respondToChallenge() is called → assessment:
        │    "acknowledged" | "disputed" | "requires_fix" + proposedFix.
        │    Response is attached to the finding as challengeResponse.
        │
        └─ PHASE 5 ── Score + verdict + summary
             Score: 100 − deductions (floor 0)
               critical: −25  |  high: −15  |  medium: −5  |  low: −2
               confirmed PoC:  −10 each (additional)
             Verdict:
               block           → any critical  OR  confirmed PoC exploit
               request-changes → any high  OR  attacker/factchecker status = fail
               approve         → medium/low only, all agents pass or warn
        │
        ▼
[Response to Extension]
  agentResults, agentStatuses, prioritizedFindings (with docSource, challengeResponse),
  challengeResponses, verdict, score, summary, sessionId
        │
        ▼
[Frontend Panels]
  • Agent Status sidebar  — per-agent ✅/⚠️/❌ status chips with tooltips
  • Verdict sidebar       — verdict icon, score, finding counts by severity,
                            builder challenge acknowledgement ratio, summary
  • Findings webview      — unified table sorted by severity; per-finding extras:
                              inline findings: line number, claim, reality
                              doc findings:    docSource filename, claim, reality
                              attacker:        CWE badge, attackVector, impact, PoC status
                              skeptic:         confidence score, category
                              all critical:    builder challengeResponse + proposedFix
  • Charts webview        — severity radar by agent, skeptic evidence (4 charts:
                            failure timeline, endpoint heatmap, latency distribution,
                            user journey failures), system flow diagram,
                            per-finding confidence bars
```

---

## Folder Structure

```
RunChecks/
├── backend/
│   ├── agents/
│   │   ├── builder.js       # gpt-5-codex — code context provider + challenge responder
│   │   ├── factchecker.js   # gpt-5-codex — inline comment check + external doc review
│   │   ├── attacker.js      # gpt-5-codex + gpt-5.1-codex-mini + shadow — 3-step exploit pipeline
│   │   ├── skeptic.js       # shadow/runner + flowParser — shadow execution + evidence
│   │   └── orchestrator.js  # 5-phase pipeline controller → verdict + score
│   ├── core/
│   │   ├── openai.js        # Shared OpenAI client (reads OPENAI_API_KEY)
│   │   ├── llm.js           # complete() — Chat Completions or Responses API (Codex)
│   │   ├── parser.js        # chunkCode, detectLanguage, buildReviewPayload
│   │   └── logger.js        # SQLite audit_log (logEntry, updateDecision, getEntries)
│   ├── context/
│   │   ├── embeddings.js    # embed() via text-embedding-3-small + cosineSimilarity
│   │   └── storage.js       # storeChunk, retrieveTopChunks (top-5 cosine), clearSession
│   ├── shadow/
│   │   ├── runner.js        # child_process snippet executor (JS only, 5 s timeout)
│   │   ├── testRunner.js    # npm test runner — parses Jest output (pass/fail/timing)
│   │   └── flowParser.js    # regex-based require/import extractor → {nodes, edges}
│   ├── index.js             # Express: POST /review, POST /decision, GET /health
│   ├── .env.example
│   └── package.json
│
└── frontend/
    ├── src/
    │   ├── extension.js          # activate(), 5 commands, auto-review on save
    │   ├── panels/
    │   │   ├── agentStatus.js    # Sidebar tree: per-agent status chips
    │   │   ├── findings.js       # Webview panel: loads findings.html
    │   │   ├── verdict.js        # Sidebar tree: verdict, score, counts, challenge info
    │   │   └── skepticCharts.js  # Webview panel: loads charts.html
    │   └── webviews/
    │       ├── findings.html     # Unified prioritizedFindings table + per-finding extras
    │       └── charts.html       # Severity radar + skeptic evidence + flow diagram
    └── package.json
```

---

## Agent Summary

| Agent | Default model | Role | Key output fields |
|-------|----------------|------|-------------------|
| **builder** | gpt-5-codex | Code context provider + challenge responder | `codeContext`, `respondToChallenge()` |
| **factchecker** | gpt-5-codex | Inline comment accuracy + external doc accuracy | `claim`, `reality`, `docSource` |
| **attacker** | gpt-5-codex (static), gpt-5.1-codex-mini (PoC) | Security vulnerability scan + PoC execution | `cwe`, `attackVector`, `impact`, `exploitProof.confirmed` |
| **skeptic** | — (no LLM) | Shadow execution + test suite runner + flow graph | `evidence` (4 chart datasets), `flow`, `confidence` |
| **orchestrator** | — | 5-phase pipeline controller | `verdict`, `score`, `prioritizedFindings`, `challengeResponses` |

**Default models** are Codex (Responses API). Override via `.env`: `BUILDER_MODEL`, `FACTCHECKER_MODEL`, `ATTACKER_MODEL`, `ATTACKER_POC_MODEL` (e.g. `gpt-4o` / `gpt-4o-mini` for Chat Completions if you don't have Codex access).

---

## Getting Started

### 1. Backend

```bash
cd backend
cp .env.example .env
# Edit .env and set OPENAI_API_KEY=sk-... (required)
npm install
npm start
# Or: node index.js
```

- Server listens on `http://localhost:3001` (or the next free port 3002, 3003, … if 3001 is in use).
- Open `http://localhost:3001` in a browser for a short API overview; `http://localhost:3001/health` returns `{"status":"ok"}`.
- **Default models** (no extra env needed): **Codex** — Builder and Attacker static use **gpt-5-codex**; Factchecker uses **gpt-5-codex**; Attacker PoC uses **gpt-5.1-codex-mini**. All use the Responses API. If your account has no Codex access, set `BUILDER_MODEL=gpt-4o`, `FACTCHECKER_MODEL=gpt-4o-mini`, `ATTACKER_MODEL=gpt-4o`, `ATTACKER_POC_MODEL=gpt-4o-mini` in `.env` to use Chat Completions instead.

### 2. Frontend (VS Code Extension)

```bash
cd frontend
# Open the frontend folder in VS Code (File → Open Folder → frontend)
# Press F5 to launch the Extension Development Host
```

In the new window, use the Code Review sidebar (shield icon) or commands (Ctrl+Shift+P → "Code Review: …"). The extension talks to `http://localhost:3001` by default; if the backend runs on another port, set **Settings → codeReview.backendUrl**.

---

## VS Code Commands

| Command | How to trigger | What it does |
|---|---|---|
| `Code Review: Review Current File` | Ctrl+Shift+P / right-click | Sends full file through all 4 agents |
| `Code Review: Review Selection` | Right-click (text selected) | Sends highlighted code only |
| `Code Review: Review File with Docs` | Ctrl+Shift+P / right-click | Opens file picker → select `.md/.txt/.rst` docs → factchecker runs a second pass comparing those docs against the code |
| `Code Review: Show Findings` | Ctrl+Shift+P | Opens/reveals findings webview |
| `Code Review: Show Skeptic Charts` | Ctrl+Shift+P | Opens/reveals charts webview |

**Settings:**

| Key | Default | Description |
|---|---|---|
| `codeReview.backendUrl`       | `http://localhost:3001` | Backend server URL |
| `codeReview.autoReviewOnSave` | `false` | Auto-review on every file save (silent — no toast) |

---

## Factchecker — Two Passes

### Pass 1: Inline comments (always runs)
Checks every comment, docstring, and JSDoc inside the code file against what the code actually does. Each finding includes the `line` number where the mismatch appears.

### Pass 2: External documentation (only with "Review File with Docs")
Accepts one or more external documents (README, API spec, design doc, changelog, etc.) and checks whether their claims match the actual implementation. Each finding includes `docSource` (the filename) so you know which document raised it.

```
Finding example (doc review):
  Agent:   factchecker
  Doc:     README.md
  Claim:   "Returns results sorted by date descending"
  Reality: "Results are returned in insertion order, no sorting applied"
  Suggest: "Either sort the results before returning or update the README"
```

---

## API Reference

| Endpoint | Method | Body | Purpose |
|---|---|---|---|
| `/review/start`    | POST | `{ code, filePath, language, workspaceRoot?, docs? }` | Step 1 — Run Builder, open session |
| `/review/next`     | POST | `{ sessionId, agent }` | Step 2/3 — Run factchecker, attacker, or skeptic |
| `/review/finalize` | POST | `{ sessionId }` | Final — Orchestrate all collected results → verdict |
| `/review`          | POST | see below | Single-shot full pipeline (auto-save, backwards compat) |
| `/decision`        | POST | `{ logId, decision }` | Record human accept/reject/defer |
| `/health`          | GET  | — | Liveness check |

**Stepped flow agent values for `/review/next`:** `"factchecker"` → `"attacker"` → `"skeptic"` (skeptic is optional)

### POST /review — request body

```json
{
  "code":          "string  (required)",
  "filePath":      "string  (required)",
  "language":      "string  (optional — auto-detected from extension)",
  "workspaceRoot": "string  (optional — enables skeptic test suite runner)",
  "diff":          "string  (optional — unified diff for context)",
  "docs": [
    { "name": "README.md",  "content": "..." },
    { "name": "API_SPEC.md","content": "..." }
  ]
}
```

### POST /review — response shape

```json
{
  "agent":   "orchestrator",
  "verdict": "approve | request-changes | block",
  "score":   85,
  "agentStatuses": {
    "builder": "pass", "factchecker": "warn", "attacker": "fail", "skeptic": "pass"
  },
  "prioritizedFindings": [
    {
      "source":      "factchecker",
      "line":        null,
      "type":        "issue",
      "description": "README claims results are sorted but code returns them unsorted",
      "severity":    "medium",
      "claim":       "Returns results sorted by date descending",
      "reality":     "Results returned in insertion order",
      "suggestion":  "Sort results or update README",
      "docSource":   "README.md"
    },
    {
      "source":      "attacker",
      "line":        42,
      "type":        "SQL Injection",
      "description": "User input concatenated directly into SQL query",
      "severity":    "critical",
      "cwe":         "89",
      "attackVector":"network",
      "impact":      "Full database read/write access",
      "suggestion":  "Use parameterised queries",
      "exploitProof":{ "confirmed": true, "output": "CONFIRMED\n..." },
      "challengeResponse": {
        "assessment":  "acknowledged",
        "explanation": "Builder confirms unvalidated input reaches the query",
        "proposedFix": "db.query('SELECT * FROM users WHERE id = ?', [id])"
      }
    }
  ],
  "challengeResponses": [ { "finding": {}, "response": {} } ],
  "summary": "BLOCK — do not merge. Score: 50/100. 1 critical, 1 medium finding(s).",
  "sessionId": "uuid"
}
```

---

## Verdict & Scoring

| Verdict | Condition |
|---|---|
| `block`           | Any **critical** finding OR any confirmed PoC exploit |
| `request-changes` | Any **high** finding OR attacker/factchecker status = `fail` |
| `approve`         | Medium/low only, all agents `pass` or `warn` |

**Score deductions** (from 100, floor 0):

| Severity | Deduction |
|---|---|
| critical | −25 |
| high | −15 |
| medium | −5 |
| low | −2 |
| confirmed PoC exploit | −10 each (extra) |

---

## Data (SQLite — `backend/data/audit.db`)

| Table | Columns |
|---|---|
| `audit_log`       | id, timestamp, agent_name, findings (JSON), human_decision, session_id, file_path |
| `document_chunks` | id, session_id, file_path, chunk_index, content, embedding (JSON) |

Created automatically on first backend start. No setup required.
