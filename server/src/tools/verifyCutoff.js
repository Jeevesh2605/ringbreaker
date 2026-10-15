// verify_cutoff(case_id): proves the cut-off with a query (SPEC 8.4, the core differentiator).
// Read-only: it runs through readQuery (GRAPH.RO_QUERY).
//
// Question: "can money from outside the ring still enter it and reach its end account?"
//   ring      = the case's non-victim members (layers, collectors, cash-out)
//   terminals = the case's cash-out accounts (or its collectors if it has no cash-out)
//
// Changes from the SPEC sketch, both tested on the seeded graph:
//   1. Start from ANY outside account that pays into the ring, not one named victim. A
//      fan-in ring (Ring B) has ~100 victims the agent may not list one by one.
//   2. Count DISTINCT ROUTES (sequences of account ids), not raw paths. Each transaction is
//      its own edge, so split payments multiply paths: Ring A has 1,488 raw paths but only
//      13 distinct routes. Routes are what a reviewer can actually read.
//
// Pattern: (src)-[:SENT]->(m)-[:SENT*0..5]->(t): one hop into the ring, then up to 5 more
// hops to a terminal (*0 allows m = t). none(...) drops any route through a frozen account.
// Before the freeze this returns > 0; after freezing the ring it must return 0.
import { readQuery } from '../db.js';

const CASE_CYPHER = `
MATCH (c:Case {id: $case_id})-[i:INCLUDES]->(a:Account)
RETURN i.role AS role, a.id AS id`;

const ROUTES_CYPHER = `
MATCH p = (src:Account)-[:SENT]->(m:Account)-[:SENT*0..5]->(t:Account)
WHERE m.id IN $ring AND t.id IN $terminals AND NOT src.id IN $ring
  AND none(n IN nodes(p) WHERE n.status = 'frozen')
RETURN count(DISTINCT [n IN nodes(p) | n.id]) AS routes, count(DISTINCT src) AS sources,
       collect(DISTINCT [n IN nodes(p) | n.id])[0..5] AS sample_routes`;

export async function verifyCutoff({ case_id }) {
  if (typeof case_id !== 'string') throw new Error('case_id is required');
  const members = await readQuery(CASE_CYPHER, { case_id });
  const ring = members.filter((m) => m.role !== 'victim').map((m) => m.id);
  const cashouts = members.filter((m) => m.role === 'cashout').map((m) => m.id);
  const terminals = cashouts.length ? cashouts : members.filter((m) => m.role === 'collector').map((m) => m.id);
  if (!ring.length || !terminals.length) {
    return { cypher: ROUTES_CYPHER, params: { case_id }, data: { routes: null, reason: 'case has no ring/terminal accounts' },
      summary: `${case_id}: nothing to verify (no ring or terminal accounts)`, nodes: [], edges: [] };
  }
  const params = { ring, terminals };
  const [r] = await readQuery(ROUTES_CYPHER, params, { timeout: 10000 });
  return {
    cypher: ROUTES_CYPHER,
    params,
    data: { routes: r.routes, sources: r.sources, sample_routes: r.sample_routes, ring, terminals },
    summary: `${r.routes} active money route(s) from ${r.sources} outside source(s) into ${terminals.join(', ')}`,
    nodes: [...new Set([...ring, ...r.sample_routes.flat()])],
    edges: [],
  };
}
