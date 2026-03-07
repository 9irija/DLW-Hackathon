export interface AgentFinding {
  type:        string;
  severity:    'critical' | 'high' | 'medium' | 'low';
  file:        string;
  line:        number;
  description: string;
  suggestion:  string;
  // Factchecker-specific extras (optional)
  codeSnippet?: string;   // lines of code around the issue
  claim?:       string;   // what the comment/doc says
  reality?:     string;   // what the code actually does
  docSource?:   string;   // source document name
  docSection?:  string;   // section heading in the document
  docPage?:     number | null; // page number if determinable
}

export interface AgentResult {
  agentName: string;
  stage:     'pre-processing' | 'factchecker' | 'attacker' | 'skeptic';
  passed:    boolean;
  findings:  AgentFinding[];
  summary?:  string;
}

export interface SessionStatus {
  currentStage:     string;
  awaitingDecision: boolean;
  agents: {
    name:   string;
    status: 'idle' | 'running' | 'passed' | 'warned' | 'failed';
  }[];
}

export interface ReviewRequest {
  code:      string;
  filePath:  string;
  lineStart: number;
  lineEnd:   number;
}

export interface Decision {
  stage:    string;
  decision: 'approve' | 'change';
}

export interface DocEntry {
  filename:   string;
  uploadedAt: string;
  chunks:     number;
}

export interface SkepticData {
  tests?: {
    passed: number;
    failed: number;
    total:  number;
  };
  traffic?: { endpoint: string; pass: number; fail: number }[];
  latency?: {
    endpoint:  string;
    p50before: number; p50after: number;
    p90before: number; p90after: number;
    p99before: number; p99after: number;
  }[];
  journeys?: { name: string; status: 'unaffected' | 'broken' | 'degraded' }[];
  flowNodes?: { id: string; label: string }[];
  flowEdges?: { from: string; to: string }[];
}
