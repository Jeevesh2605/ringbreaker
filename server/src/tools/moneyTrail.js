// money_trail(account_id, direction, max_hops, since): follow money forward (where did it
// go?) or backward (where did it come from?) up to max_hops, using only transactions at or
// after `since`.
import { readQuery } from '../db.js';

const PATH_LIMIT = 500;

// Cypher cannot take a parameter for an edge direction or for the bounds of a variable-length
// pattern (*1..N). So we pre-build one query text per (direction, hops) combination from
// CONSTANTS at load time. The caller only picks a key from this fixed table; user input is
// never spliced into Cypher text. Account id and `since` stay real $parameters.
//
// Query shape:
//   1. MATCH every SENT path of 1..N hops starting at the account.
//   2. Keep paths where EVERY transaction is at/after $since (all() over relationships(p)).
//      This filters out months of unrelated background payments.
//   3. Cap the number of paths (transactions are individual edges, so split payments
//      multiply paths combinatorially: Ring A alone has 144 victim->cash-out paths).
//   4. UNWIND the paths into their edges and keep DISTINCT ones. The agent gets the set
//      of transactions involved, not hundreds of near-duplicate paths.
function buildQuery(direction, hops) {
  const pattern = direction === 'forward'
    ? `(a:Account {id: $account_id})-[:SENT*1..${hops}]->(x:Account)`
    : `(a:Account {id: $account_id})<-[:SENT*1..${hops}]-(x:Account)`;
  return `
MATCH p = ${pattern}
WHERE all(r IN relationships(p) WHERE r.ts >= $since)
WITH p LIMIT ${PATH_LIMIT}
WITH collect(p) AS paths, count(p) AS path_count
UNWIND paths AS p
UNWIND relationships(p) AS r
WITH DISTINCT path_count, r
RETURN path_count, startNode(r).id AS from, endNode(r).id AS to,
       r.txn_id AS txn_id, r.amount AS amount, r.ts AS ts
ORDER BY ts`;
}

const QUERIES = {};
for (const dir of ['forward', 'backward']) {
  for (let h = 1; h <= 4; h++) QUERIES[`${dir}:${h}`] = buildQuery(dir, h);
}

// Account details for everyone on the trail, so the agent can see who is new/min-KYC.
const ACCOUNTS_CYPHER = `
MATCH (a:Account) WHERE a.id IN $ids
RETURN a.id AS id, a.kyc_level AS kyc_level, a.status AS status, a.created_at AS created_at`;

export async function moneyTrail({ account_id, direction = 'forward', max_hops = 3, since = 0 }) {
  if (typeof account_id !== 'string' || !account_id) throw new Error('account_id (string) is required');
  if (!['forward', 'backward'].includes(direction)) throw new Error("direction must be 'forward' or 'backward'");
  const hops = Number(max_hops);
  if (!Number.isInteger(hops) || hops < 1 || hops > 4) throw new Error('max_hops must be an integer 1..4');
  // `since` may be epoch ms or an ISO date string.
  const sinceMs = typeof since === 'string' ? Date.parse(since) : Number(since);
  if (!Number.isFinite(sinceMs)) throw new Error('since must be epoch ms or an ISO date');

  const cypher = QUERIES[`${direction}:${hops}`];
  const params = { account_id, since: sinceMs };
  const rows = await readQuery(cypher, params);

  const pathCount = rows[0]?.path_count ?? 0;
  const txns = rows.map(({ from, to, txn_id, amount, ts }) => ({
    from, to, txn_id, amount, ts: new Date(ts).toISOString(),
  }));
  const ids = [...new Set([account_id, ...txns.flatMap((t) => [t.from, t.to])])];
  const accounts = ids.length > 1 ? await readQuery(ACCOUNTS_CYPHER, { ids }) : [];
  const total = txns.reduce((s, t) => s + t.amount, 0);

  return {
    cypher,
    params,
    data: {
      truncated: pathCount >= PATH_LIMIT,
      transactions: txns,
      accounts: accounts.map((a) => ({ ...a, created_at: new Date(a.created_at).toISOString() })),
    },
    summary: `${direction} ${hops} hop(s) from ${account_id}: ${pathCount}${pathCount >= PATH_LIMIT ? '+' : ''} paths, ` +
      `${txns.length} txns, ${ids.length} accounts, sum of txn amounts ${total}`,
    nodes: ids,
    edges: txns.map((t) => t.txn_id),
  };
}
