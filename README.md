# RunChecks — AI-Powered Code Review

> **AI-powered code review. Human-controlled decisions.**

Six specialized AI agents review your code in three sequential stages. A human checkpoint gate appears after every stage — you decide whether to approve and continue, stop and make changes, or request an optional deeper analysis. The orchestrator synthesizes all findings into a scored verdict: `APPROVE / REQUEST CHANGES / BLOCK`.

Built for the **DLW Hackathon — OpenAI Track** using the OpenAI Responses API with Codex models, served through an Express backend.

---

## Agent Pipeline

```
⚙️  Code Parser     ─┐
                      ├─ Pre-processing (runs automatically on review start)
🧠 Code Reasoner   ─┘
                           👤 GATE 0: Notification — Continue to Fact Checker or Stop
──────────────── STAGE 1 ─────────────────────────────────────────────────────
🕵️  Fact Checker      — comment accuracy, doc compliance, hallucination detection
                           👤 GATE 1: FindingsPanel — Approve & Continue or Request Changes
──────────────── STAGE 2 ─────────────────────────────────────────────────────
⚔️  Attacker          — OWASP security scan, PoC exploit generation, CWE tagging
                           👤 GATE 2: FindingsPanel — Approve & Continue or Request Changes
──────────────── STAGE 3 (Optional) ─────────────────────────────────────────
🧪 Skeptic           — shadow execution, traffic replay, latency impact scoring
                           👤 GATE 3: SkepticPanel — Approve as Safe or Request Changes
─────────────────────────────────────────────────────────────────────────────
🎯 Orchestrator      — compute final verdict + score from all collected results
```

Pre-processing (Parser + Reasoner) is always synchronous and automatic. Every subsequent stage requires explicit human approval before the next agent runs — nothing advances without a deliberate decision.

---

## What Each Agent Does

| Agent | Role | Output |
|---|---|---|
| **Parser** | Splits code into logical segments (functions, classes, blocks) | Structured segments with language + line ranges |
| **Reasoner** | Enriches segments with doc context → `CodeContext` | Unified analysis payload for downstream agents |
| **Fact Checker** | Two-pass accuracy check: inline comments vs implementation, external docs vs code. Uses absolute line-numbered prompts and `buildNumberedCode` for correct snippet extraction | Findings with `claim`, `reality`, `codeSnippet`, `severity`, `line`, `suggestion`, `docSource?` |
| **Attacker** | Adversarial security scan: injection, auth bypass, data exposure, OWASP Top-10 | Findings with CWE ID, PoC evidence, exploit risk |
| **Skeptic** | Shadow execution + test suite runner. Synthesises findings and latency data into an actionable `recommendation` (`approve` / `review` / `hold`) with concrete reasons | Pass/fail breakdown, latency distribution, user journey status, `recommendation` |
| **DocReader** | Ingest PDFs, DOCX, and plain-text docs. Handles native Buffers, JSON-serialised Buffers, data URLs, and bare base64 | `{ docs: [{ name, pageCount, sections }] }` |
| **Orchestrator** | Collects results, normalises findings, computes score, issues verdict | `verdict`, `score`, `prioritizedFindings`, `agentResults` |

---

## Folder Structure

```
RunChecks/
├── .vscode/
│   ├── launch.json          ← F5 launches extension from repo root
│   └── tasks.json           ← compile-frontend / watch-frontend / start-backend
│
├── backend/
│   ├── agents/
│   │   ├── orchestrator.js  ← pipeline controller, finalize(), runAgent()
│   │   ├── parser.js        ← code splitting into logical segments
│   │   ├── reasoner.js      ← CodeContext enrichment
│   │   ├── docreader.js     ← PDF / DOCX / Markdown ingestion + text extraction
│   │   ├── factchecker.js   ← two-pass accuracy check (inline + external docs)
│   │   ├── attacker.js      ← security scan + PoC exploit generation
│   │   └── skeptic.js       ← shadow execution, traffic replay, latency scoring
│   ├── core/
│   │   ├── llm.js           ← unified LLM client (Responses API + Chat Completions)
│   │   ├── logger.js        ← SQLite audit_log (session audit trail)
│   │   └── parser.js        ← buildReviewPayload, chunkCode, detectLanguage
│   ├── context/
│   │   ├── embeddings.js    ← text-embedding-3-small via OpenAI
│   │   └── storage.js       ← chunk store + cosine similarity retrieval (top-5)
│   ├── shadow/
│   │   ├── runner.js        ← child_process snippet executor (JS)
│   │   ├── testRunner.js    ← test suite runner (jest/mocha detection)
│   │   └── flowParser.js    ← import/require graph → nodes + edges
│   ├── data/audit.db        ← SQLite database (auto-created)
│   ├── .env.example
│   └── index.js             ← Express server (port 3001)
│
├── frontend/                ← VS Code extension (TypeScript + webpack)
│   ├── src/
│   │   ├── extension.ts          ← activate(), HITL stepped review flow
│   │   ├── extension.js          ← legacy JS extension (HITL, kept for reference)
│   │   ├── types/agents.ts       ← shared TypeScript interfaces
│   │   ├── utils/
│   │   │   ├── backendClient.ts  ← HTTP client (startReview, runNextAgent, finalizeReview)
│   │   │   ├── highlighter.ts    ← VS Code decoration API (per-severity line highlights)
│   │   │   └── messageHandler.ts ← CSP nonce + HTML escaping
│   │   └── panels/
│   │       ├── AgentStatusPanel.ts  ← sidebar WebviewView — live pipeline strip
│   │       ├── SetupPanel.ts        ← doc upload (local memory) + guidance
│   │       ├── FindingsPanel.ts     ← per-agent findings + Approve / Request Changes
│   │       └── SkepticPanel.ts      ← test results, Chart.js bar chart, flow diagram
│   ├── media/icon.svg
│   ├── webpack.config.js
│   ├── tsconfig.json
│   └── package.json
│
├── docs/
│   └── dlw-hackathon.md     ← hackathon submission documentation
│
└── README.md
```

---

## How to Run

### Step 1 — Start the backend

```bash
cd backend
cp .env.example .env      # fill in OPENAI_API_KEY
npm install
node index.js             # listens on http://localhost:3001
```

Backend API endpoints:

| Endpoint | Method | Purpose |
|---|---|---|
| `/review/start` | POST | Run Parser + Reasoner, open session |
| `/review/next` | POST | Run `factchecker`, `attacker`, or `skeptic` |
| `/review/finalize` | POST | Compute final verdict from collected results |
| `/review` | POST | Single-shot full pipeline (backwards-compatible) |
| `/health` | GET | Liveness check |

### Step 2 — Launch the extension

Open the **`RunChecks/` root folder** in VS Code (not the `frontend/` subfolder), then press **F5**.

VS Code will:
1. Run `npm run compile` inside `frontend/` automatically (webpack bundles TypeScript)
2. Open the **Extension Development Host** with RunChecks installed

> First launch only: `cd frontend && npm install` before pressing F5 if you haven't installed devDependencies yet.

### Step 3 — Use RunChecks

| Action | How |
|---|---|
| Review selected code | Highlight code → right-click → **🔍 Run RunChecks Review** |
| Review entire file | `Ctrl+Shift+P` → **🔍 Run RunChecks Review** (no selection) |
| Upload reference docs | `Ctrl+Shift+P` → **RunChecks: Setup & Documents** |
| Show agent pipeline | Click the **shield icon** in the activity bar |

**Review flow (human-in-the-loop):**

1. Review starts → backend runs Parser + Reasoner automatically
2. VS Code notification: **"Pre-processing complete. Run Fact Checker?"** → click to continue
3. Fact Checker runs → **FindingsPanel** opens with results (each finding shows CLAIM / REALITY / CODE snippet / clickable file link)
4. Click **✅ Approve & Continue** → Attacker runs → FindingsPanel updates
5. Click **✅ Approve & Continue** → modal asks: **"Run Skeptic"** or **"Finalize Now"**
6. (Optional) Skeptic runs → **SkepticPanel** opens with a colour-coded recommendation banner (`approve` / `review` / `hold`), test results, latency charts, and a system flow diagram
7. Click **✅ Approve** → final verdict notification (`APPROVE / REQUEST CHANGES / BLOCK` + score)

At any gate, **✏️ Make Changes** stops the pipeline so you can fix issues before re-running.

---

## Verdict & Scoring

| Verdict | Trigger |
|---|---|
| `APPROVE` | No high/critical findings, no confirmed PoC exploits |
| `REQUEST CHANGES` | High-severity findings or agent-level failure |
| `BLOCK` | Critical findings or PoC-confirmed exploit |

Score starts at **100** and deducts per finding:

| Severity | Deduction |
|---|---|
| Critical | −25 |
| High | −15 |
| Medium | −5 |
| Low | −2 |
| PoC-confirmed exploit | −10 each (additional) |

---

## Configuration

| Setting | Default | Description |
|---|---|---|
| `runchecks.backendUrl` | `http://127.0.0.1:3001` | Backend server URL |

Set in VS Code Settings (`Ctrl+,` → search `runchecks`).

---

## Environment Variables (`backend/.env`)

```
OPENAI_API_KEY=sk-...

# Model overrides (all default to gpt-4o or gpt-4o-mini if unset)
CODEX_MODEL=gpt-4o
FACTCHECKER_MODEL=gpt-4o-mini
ATTACKER_MODEL=gpt-4o
PORT=3001
```

---

## Tech Stack

| Layer | Technology |
|---|---|
| Backend | Node.js, Express, CommonJS |
| LLM | OpenAI Responses API (`gpt-4o` / `gpt-4o-mini`) |
| Embeddings | `text-embedding-3-small` |
| Vector store | SQLite (cosine similarity, top-5 retrieval) |
| Doc parsing | `pdf-parse` (PDF), `mammoth` (DOCX) |
| Audit log | SQLite (`audit_log` table) |
| Frontend | VS Code Extension API, TypeScript, webpack |
| UI | VS Code Webview (CSP-safe, nonce-protected) |
| Charts | Chart.js 4 (CDN, Skeptic panel only — CSS vars resolved via `getComputedStyle`) |
