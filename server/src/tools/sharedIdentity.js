// shared_identity(account_id): other accounts that use the same device or phone number.
// Shared identity alone is weak evidence (families share phones); combined with a money
// link it is strong.
import { readQuery } from '../db.js';

// Two-hop pattern through any Device or Phone node:
//   (a)-[:USES_DEVICE|LINKED_PHONE]->(x)<-[:USES_DEVICE|LINKED_PHONE]-(b)
// The | means "either relationship type" (FalkorDB supports this).
// For each other account b we also check for a direct money link with a, so the agent
// can tell "shares a phone AND moves money" from "only shares a phone".
const CYPHER = `
MATCH (a:Account {id: $account_id})-[:USES_DEVICE|LINKED_PHONE]->(x)<-[:USES_DEVICE|LINKED_PHONE]-(b:Account)
WHERE b.id <> $account_id
WITH a, b, collect(DISTINCT {kind: labels(x)[0], key: coalesce(x.id, x.number)}) AS shared
OPTIONAL MATCH (a)-[m:SENT]-(b)
RETURN b.id AS id, b.holder AS holder, b.kyc_level AS kyc_level, b.status AS status,
       b.created_at AS created_at, shared, count(m) AS direct_txns
ORDER BY size(shared) DESC, id
LIMIT 50`;

export async function sharedIdentity({ account_id }) {
  if (typeof account_id !== 'string' || !account_id) throw new Error('account_id (string) is required');
  const params = { account_id };
  const rows = await readQuery(CYPHER, params);
  const accounts = rows.map((r) => ({ ...r, created_at: new Date(r.created_at).toISOString() }));
  const keys = [...new Set(accounts.flatMap((a) => a.shared.map((s) => s.key)))];
  const withMoney = accounts.filter((a) => a.direct_txns > 0).length;
  return {
    cypher: CYPHER,
    params,
    data: { accounts },
    summary: `${account_id} shares ${keys.length} device/phone(s) with ${accounts.length} account(s); ` +
      `${withMoney} of them also have direct money links`,
    nodes: [account_id, ...keys, ...accounts.map((a) => a.id)],
    edges: accounts.flatMap((a) => a.shared.map((s) => {
      const rel = s.kind === 'Device' ? 'USES_DEVICE' : 'LINKED_PHONE';
      return [`${account_id}>${rel}>${s.key}`, `${a.id}>${rel}>${s.key}`];
    })).flat(),
  };
}
