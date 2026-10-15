// run_readonly_cypher(query): guarded free-form fallback for questions the specialized tools
// can't answer. Every query passes guard.js, then runs as GRAPH.RO_QUERY with a short timeout.
import { readQuery } from '../db.js';
import { guardCypher } from '../guard.js';

const TIMEOUT_MS = 3000;

// Collect account/device/phone/alert ids from result values, so the trace can highlight them.
const ID_RE = /^(ACC|DEV|ALT|TXN)\d+$|^\+91-/;
function collectIds(value, nodes, edges) {
  if (typeof value === 'string' && ID_RE.test(value)) (value.startsWith('TXN') ? edges : nodes).add(value);
  else if (Array.isArray(value)) value.forEach((v) => collectIds(v, nodes, edges));
  else if (value && typeof value === 'object') Object.values(value).forEach((v) => collectIds(v, nodes, edges));
}

export async function runReadonlyCypher({ query }) {
  const g = guardCypher(query);
  if (!g.ok) throw new Error(`rejected by guard: ${g.reason}`);
  const rows = await readQuery(g.query, {}, { timeout: TIMEOUT_MS });
  const nodes = new Set(), edges = new Set();
  collectIds(rows, nodes, edges);
  return {
    cypher: g.query,
    params: {},
    data: { rows },
    summary: `free-form query returned ${rows.length} row(s)`,
    nodes: [...nodes],
    edges: [...edges],
  };
}
