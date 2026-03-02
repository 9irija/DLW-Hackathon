import * as http  from 'http';
import * as https from 'https';
import * as vscode from 'vscode';

function getBaseUrl(): string {
  return vscode.workspace.getConfiguration('runchecks').get<string>('backendUrl', 'http://127.0.0.1:3001');
}

function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  return new Promise((resolve, reject) => {
    const data   = body ? JSON.stringify(body) : undefined;
    const rawUrl = `${getBaseUrl()}${path}`;
    let url: URL;
    try { url = new URL(rawUrl); } catch { return reject(new Error(`Invalid URL: ${rawUrl}`)); }

    const lib     = url.protocol === 'https:' ? https : http;
    const port    = url.port ? Number(url.port) : (url.protocol === 'https:' ? 443 : 80);
    const headers: Record<string, string | number> = { 'Content-Type': 'application/json' };
    if (data) { headers['Content-Length'] = Buffer.byteLength(data); }

    const req = lib.request(
      { hostname: url.hostname, port, path: url.pathname + url.search, method, headers },
      res => {
        let raw = '';
        res.on('data', chunk => { raw += chunk; });
        res.on('end', () => {
          try { resolve(JSON.parse(raw || '{}')); }
          catch { reject(new Error('Invalid JSON from backend')); }
        });
      }
    );
    req.on('error', reject);
    if (data) { req.write(data); }
    req.end();
  });
}

// ─── Response shapes matching the real backend API ────────────────────────────

export interface StartReviewResponse {
  sessionId:      string;
  stage:          string;
  nextAgent:      string;
  reasonerResult: Record<string, unknown>;
  partialReview:  Record<string, unknown>;
  checkpoint:     { type: string; requiresApproval: boolean; message: string; };
}

export interface NextAgentResponse {
  sessionId:    string;
  ranAgent:     string;
  agentResult:  Record<string, unknown>;
  checkpoint:   { type: string; requiresApproval: boolean; message: string; nextAgent: string | null; };
  partialReview: { verdict: string; score: number; };
}

export interface FinalizeResponse {
  verdict:             string;
  score:               number;
  prioritizedFindings: unknown[];
}

// ─── API functions ─────────────────────────────────────────────────────────────

/** POST /review/start — runs pre-processing pipeline, returns sessionId + checkpoint */
export function startReview(
  code:      string,
  filePath:  string,
  lineStart: number,
  lineEnd:   number,
): Promise<StartReviewResponse> {
  return request('POST', '/review/start', { code, filePath, lineStart, lineEnd });
}

/** POST /review/next — runs factchecker, attacker, or skeptic for an existing session */
export function runNextAgent(sessionId: string, agent: string): Promise<NextAgentResponse> {
  return request('POST', '/review/next', { sessionId, agent });
}

/** POST /review/finalize — computes final verdict from all collected results */
export function finalizeReview(sessionId: string): Promise<FinalizeResponse> {
  return request('POST', '/review/finalize', { sessionId });
}

/** GET /health — liveness check */
export function checkHealth(): Promise<{ status: string }> {
  return request('GET', '/health');
}
