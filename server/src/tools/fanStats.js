// fan_stats(account_id, since): in/out degree, totals and time spread.
// Mules show many distinct senders in a short window, then a pass-through of almost
// everything; merchants show many senders spread over months and keep most of the money.
import { readQuery } from '../db.js';

const HOUR = 3_600_000;

// Inbound and outbound are aggregated in two stages. The WITH between them collapses
// the inbound rows to one row first; otherwise the second OPTIONAL MATCH would multiply
// rows (inbound x outbound) and inflate every sum and count.
const CYPHER = `
MATCH (a:Account {id: $account_id})
OPTIONAL MATCH (s:Account)-[i:SENT]->(a) WHERE i.ts >= $since
WITH a, count(DISTINCT s) AS in_deg, count(i) AS in_count, sum(i.amount) AS in_total,
     min(i.ts) AS first_in, max(i.ts) AS last_in
OPTIONAL MATCH (a)-[o:SENT]->(t:Account) WHERE o.ts >= $since
RETURN in_deg, in_count, in_total, first_in, last_in,
       count(DISTINCT t) AS out_deg, count(o) AS out_count, sum(o.amount) AS out_total,
       min(o.ts) AS first_out, max(o.ts) AS last_out`;

const iso = (ms) => (ms == null ? null : new Date(ms).toISOString());

export async function fanStats({ account_id, since = 0 }) {
  if (typeof account_id !== 'string' || !account_id) throw new Error('account_id (string) is required');
  const sinceMs = typeof since === 'string' ? Date.parse(since) : Number(since);
  if (!Number.isFinite(sinceMs)) throw new Error('since must be epoch ms or an ISO date');
  const params = { account_id, since: sinceMs };
  const rows = await readQuery(CYPHER, params);
  if (!rows.length) {
    return { cypher: CYPHER, params, data: null, summary: `account ${account_id} not found`, nodes: [], edges: [] };
  }
  const r = rows[0];
  const data = {
    in_deg: r.in_deg, in_count: r.in_count, in_total: r.in_total,
    out_deg: r.out_deg, out_count: r.out_count, out_total: r.out_total,
    first_in: iso(r.first_in), last_in: iso(r.last_in),
    first_out: iso(r.first_out), last_out: iso(r.last_out),
    // How many hours the inbound payments were spread over (small = burst).
    in_span_hours: r.first_in == null ? null : Math.round((r.last_in - r.first_in) / HOUR),
    // Share of inbound money that left again. Close to 1.0 = pass-through account.
    pass_through_ratio: r.in_total > 0 ? Math.round((r.out_total / r.in_total) * 100) / 100 : null,
  };
  return {
    cypher: CYPHER,
    params,
    data,
    summary: `${account_id}: in ${data.in_deg} senders/${data.in_total}, out ${data.out_deg} receivers/${data.out_total}, ` +
      `inbound span ${data.in_span_hours ?? '-'}h, pass-through ${data.pass_through_ratio ?? '-'}`,
    nodes: [account_id],
    edges: [],
  };
}
