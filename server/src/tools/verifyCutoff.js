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
//
// LEAK CHECK. The route count alone is circular: every route it counts passes through a case
// member, so freezing everything the case proposed always gives 0, even if the agent missed
// part of the ring. (Seen in a real run: the agent stopped at collector ACC1900 and never
// named cash-out ACC1901, which had already received Rs 65,202 and stayed active.)
// So we also ask a question the case cannot answer for itself:
//   "did money already leave the ring to an ACTIVE account outside the case?"
// Any such account is a leak: the cut-off is not proven until it is reviewed. Freezing case
// members does not change this number (the receiver is outside the case), so it measures
// whether the case is COMPLETE, not whether the freeze happened.
// On the seeded data, a case with Ring A's or Ring B's true members has 0 leaks: their
// cash-outs never send money on, so no time window is needed.
// Known limit: this looks downstream only. A missed mule UPSTREAM of the case (one that
// forwards victim money into it) is not a leak by this definition, and is not flagged.
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

// Every payment from a non-victim member (r) to an account (x) outside the case that is
// still active. sum() over zero rows is 0, so the no-leak case still returns one row.
const LEAK_CYPHER = `
MATCH (r:Account)-[s:SENT]->(x:Account)
WHERE r.id IN $ring AND NOT x.id IN $members AND x.status = 'active'
RETURN count(DISTINCT x) AS leaks, sum(s.amount) AS leaked_amount,
       collect(DISTINCT x.id)[0..5] AS leak_accounts`;

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
  const params = { ring, terminals, members: members.map((m) => m.id) };
  const [[r], [l]] = await Promise.all([
    readQuery(ROUTES_CYPHER, params, { timeout: 10000 }),
    readQuery(LEAK_CYPHER, params),
  ]);
  const leakText = l.leaks
    ? `; LEAK: ${l.leaks} active account(s) outside the case received ${l.leaked_amount} from the ring (${l.leak_accounts.join(', ')})`
    : '; no ring money left to an active outside account';
  return {
    cypher: `${ROUTES_CYPHER.trim()}\n\n// leak check\n${LEAK_CYPHER.trim()}`,
    params,
    data: {
      routes: r.routes, sources: r.sources, sample_routes: r.sample_routes, ring, terminals,
      leaks: l.leaks, leaked_amount: l.leaked_amount, leak_accounts: l.leak_accounts,
      cut: r.routes === 0 && l.leaks === 0, // the cut-off is proven only if BOTH are zero
    },
    summary: `${r.routes} active money route(s) from ${r.sources} outside source(s) into ${terminals.join(', ')}${leakText}`,
    nodes: [...new Set([...ring, ...r.sample_routes.flat(), ...l.leak_accounts])],
    edges: [],
  };
}
