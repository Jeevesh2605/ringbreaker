// expand_ring(seed_ids, hops, since): grow a candidate ring from known suspects by
// following BOTH money links and shared devices/phones, one hop at a time.
import { readQuery } from '../db.js';

const PER_HOP_LIMIT = 30;

// One hop of expansion from the current set $ids, as a UNION ALL of two patterns:
//   1. money:    any SENT edge (either direction) at/after $since to an account outside the set
//   2. identity: any account outside the set sharing a Device or Phone with the set
// weight = number of transactions (money) or number of shared devices/phones (identity).
// Ranking by weight and a LIMIT keep a busy account from pulling in hundreds of
// ordinary contacts.
const HOP_CYPHER = `
MATCH (a:Account)-[t:SENT]-(b:Account)
WHERE a.id IN $ids AND NOT b.id IN $ids AND t.ts >= $since
RETURN b.id AS id, 'money' AS via, count(t) AS weight, collect(t.txn_id)[0..20] AS txn_ids, collect(DISTINCT a.id) AS linked_to
UNION ALL
MATCH (a:Account)-[:USES_DEVICE|LINKED_PHONE]->(x)<-[:USES_DEVICE|LINKED_PHONE]-(b:Account)
WHERE a.id IN $ids AND NOT b.id IN $ids
RETURN b.id AS id, 'identity' AS via, count(DISTINCT x) AS weight, [] AS txn_ids, collect(DISTINCT a.id) AS linked_to`;

const ACCOUNTS_CYPHER = `
MATCH (a:Account) WHERE a.id IN $ids
RETURN a.id AS id, a.kyc_level AS kyc_level, a.status AS status, a.created_at AS created_at`;

export async function expandRing({ seed_ids, hops = 1, since = 0 }) {
  if (!Array.isArray(seed_ids) || !seed_ids.length || !seed_ids.every((x) => typeof x === 'string')) {
    throw new Error('seed_ids must be a non-empty array of account ids');
  }
  const h = Number(hops);
  if (!Number.isInteger(h) || h < 1 || h > 2) throw new Error('hops must be 1 or 2');
  const sinceMs = typeof since === 'string' ? Date.parse(since) : Number(since);
  if (!Number.isFinite(sinceMs)) throw new Error('since must be epoch ms or an ISO date');

  const members = new Set(seed_ids);
  const added = [];   // {id, hop, via:[...], weight, linked_to}
  const edges = new Set();
  for (let hop = 1; hop <= h; hop++) {
    const rows = await readQuery(HOP_CYPHER, { ids: [...members], since: sinceMs });
    // Merge money+identity rows per account, then keep the strongest PER_HOP_LIMIT.
    const byId = new Map();
    for (const r of rows) {
      const cur = byId.get(r.id) || { id: r.id, hop, via: [], weight: 0, linked_to: new Set() };
      cur.via.push(r.via);
      cur.weight += r.weight;
      r.linked_to.forEach((x) => cur.linked_to.add(x));
      r.txn_ids.forEach((t) => edges.add(t));
      byId.set(r.id, cur);
    }
    const next = [...byId.values()]
      .sort((a, b) => b.via.length - a.via.length || b.weight - a.weight) // linked BOTH ways first
      .slice(0, PER_HOP_LIMIT);
    if (!next.length) break;
    for (const n of next) {
      members.add(n.id);
      added.push({ ...n, linked_to: [...n.linked_to] });
    }
  }

  const details = added.length ? await readQuery(ACCOUNTS_CYPHER, { ids: added.map((a) => a.id) }) : [];
  const detailById = new Map(details.map((d) => [d.id, d]));
  const candidates = added.map((a) => {
    const d = detailById.get(a.id) || {};
    return { ...a, kyc_level: d.kyc_level, status: d.status,
      created_at: d.created_at ? new Date(d.created_at).toISOString() : null };
  });
  const both = candidates.filter((c) => c.via.length > 1).length;
  return {
    cypher: HOP_CYPHER,
    params: { ids: seed_ids, since: sinceMs, hops: h },
    data: { seed_ids, candidates },
    summary: `expanded ${seed_ids.length} seed(s) by ${h} hop(s): ${candidates.length} candidates ` +
      `(${both} linked by both money and identity)`,
    nodes: [...members],
    edges: [...edges],
  };
}
