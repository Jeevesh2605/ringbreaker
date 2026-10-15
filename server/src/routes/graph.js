// GET /api/graph/subgraph?nodeIds=ACC1,DEV2,...  nodes + edges for the canvas.
// GET /api/case/:id/report                        markdown report.
//
// The canvas asks for exactly the ids named in the agent trace (plus anything it already
// shows), and gets back those nodes and every edge running between them.
import { Router } from 'express';
import { readQuery } from '../db.js';
import { actions } from '../tools/index.js';

const MAX_IDS = 400;

// Nodes: one indexed lookup per label (each label has its own key property), joined by
// UNION ALL. labels(n)[0] tells the UI how to color the node.
const NODES_CYPHER = `
MATCH (n:Account) WHERE n.id IN $ids RETURN n.id AS id, 'Account' AS label, properties(n) AS props
UNION ALL MATCH (n:Device) WHERE n.id IN $ids RETURN n.id AS id, 'Device' AS label, properties(n) AS props
UNION ALL MATCH (n:Phone) WHERE n.number IN $ids RETURN n.number AS id, 'Phone' AS label, properties(n) AS props
UNION ALL MATCH (n:VPA) WHERE n.handle IN $ids RETURN n.handle AS id, 'VPA' AS label, properties(n) AS props
UNION ALL MATCH (n:Alert) WHERE n.id IN $ids RETURN n.id AS id, 'Alert' AS label, properties(n) AS props
UNION ALL MATCH (n:Case) WHERE n.id IN $ids RETURN n.id AS id, 'Case' AS label, properties(n) AS props`;

// Edges: every edge with an Account on one end touches it, so starting from the requested
// accounts covers SENT, USES_DEVICE, LINKED_PHONE, HAS_VPA, ABOUT, INCLUDES and ACTION.
// coalesce() picks whichever key property the other node has. startNode() keeps the direction.
const EDGES_CYPHER = `
MATCH (a:Account)-[r]-(b)
WHERE a.id IN $ids AND coalesce(b.id, b.number, b.handle) IN $ids
WITH DISTINCT r
RETURN type(r) AS type, coalesce(startNode(r).id, startNode(r).number, startNode(r).handle) AS source,
       coalesce(endNode(r).id, endNode(r).number, endNode(r).handle) AS target,
       r.txn_id AS txn_id, r.amount AS amount, r.ts AS ts, r.role AS role`;

export const graphRouter = Router();

graphRouter.get('/graph/subgraph', async (req, res, next) => {
  try {
    const ids = [...new Set(String(req.query.nodeIds ?? '').split(',').map((s) => s.trim()).filter(Boolean))];
    if (!ids.length) return res.status(400).json({ error: 'nodeIds is required (comma-separated)' });
    if (ids.length > MAX_IDS) return res.status(400).json({ error: `at most ${MAX_IDS} nodeIds` });
    const [nodes, rawEdges] = await Promise.all([readQuery(NODES_CYPHER, { ids }), readQuery(EDGES_CYPHER, { ids })]);
    // Edge id convention matches the trace: txn_id for SENT, "<from>>TYPE><to>" otherwise.
    const edges = rawEdges.map((e) => ({ ...e, id: e.txn_id ?? `${e.source}>${e.type}>${e.target}` }));
    res.json({ nodes, edges });
  } catch (e) { next(e); }
});

graphRouter.get('/case/:id/report', async (req, res, next) => {
  try {
    const r = await actions.generate_report({ case_id: req.params.id });
    res.type('text/markdown').send(r.data.markdown);
  } catch (e) {
    if (/not found/.test(e.message)) return res.status(404).json({ error: e.message });
    next(e);
  }
});
