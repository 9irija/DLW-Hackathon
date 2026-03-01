/**
 * Extracts dependency graph from source code (requires/imports) for system flow diagram.
 */

/**
 * @param {string} code - file source
 * @param {string} filePath - path of the file (used as node id)
 * @returns {{ nodes: Array<{ id: string, label: string, file?: string }>, edges: Array<{ from: string, to: string }> }}
 */
function buildFlowFromCode(code, filePath) {
  const nodes = [];
  const edges = [];
  const seen = new Set();

  const baseName = filePath ? filePath.split(/[/\\]/).pop() : 'reviewed-file';
  const fileId = filePath ? filePath.replace(/[/\\]/g, '_') : 'current';
  if (!seen.has(fileId)) {
    seen.add(fileId);
    nodes.push({ id: fileId, label: baseName, file: filePath });
  }

  // require('...') or require("...")
  const requireRe = /require\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
  // import x from '...' or import '...' or import { a } from '...'
  const importRe = /import\s+(?:[\w{}\s,*]+\s+from\s+)?['"]([^'"]+)['"]/g;

  let m;
  while ((m = requireRe.exec(code)) !== null) {
    addDep(m[1], fileId, baseName);
  }
  while ((m = importRe.exec(code)) !== null) {
    addDep(m[1], fileId, baseName);
  }

  function addDep(spec, fromId, fromLabel) {
    const specNorm = spec.replace(/^\.\//, '').split(/[/\\]/).pop().replace(/\.[^.]+$/, '') || spec;
    const toId = 'dep_' + specNorm;
    if (!seen.has(toId)) {
      seen.add(toId);
      nodes.push({ id: toId, label: specNorm, file: spec });
    }
    edges.push({ from: fromId, to: toId });
  }

  return { nodes, edges };
}

module.exports = { buildFlowFromCode };
