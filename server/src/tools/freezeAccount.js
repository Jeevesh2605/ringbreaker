// freeze_account(case_id, account_id, reason, approved_by): ACTION tool (writes).
// Only the approval API calls this, after a human clicks Approve. The model has no access.
//
// Guard rails, all enforced inside the single Cypher query:
//   - the account must be in the case's proposed_freezes list (you can only approve what
//     the investigation proposed),
//   - the account must currently be active (re-approving is a no-op, not a second action).
// Every freeze writes an audit edge (Case)-[:ACTION {type, ts, approved_by, reason}]->(Account).
import { writeQuery } from '../db.js';

const CYPHER = `
MATCH (c:Case {id: $case_id}), (a:Account {id: $account_id})
WHERE $account_id IN c.proposed_freezes AND a.status = 'active'
SET a.status = 'frozen'
CREATE (c)-[:ACTION {type: 'freeze', ts: $now, approved_by: $approved_by, reason: $reason}]->(a)
RETURN a.id AS id, a.status AS status`;

export async function freezeAccount({ case_id, account_id, reason = '', approved_by }) {
  if (typeof case_id !== 'string' || typeof account_id !== 'string') throw new Error('case_id and account_id are required');
  if (typeof approved_by !== 'string' || !approved_by.trim()) throw new Error('approved_by is required: freezes need a named approver');
  const params = { case_id, account_id, reason: String(reason).slice(0, 500), approved_by, now: Date.now() };
  const rows = await writeQuery(CYPHER, params);
  const frozen = rows.length === 1;
  return {
    cypher: CYPHER, params, data: { account_id, frozen },
    summary: frozen
      ? `froze ${account_id} (approved by ${approved_by})`
      : `did not freeze ${account_id}: not proposed in ${case_id}, unknown, or already frozen`,
    nodes: [account_id],
    edges: frozen ? [`${case_id}>ACTION>${account_id}`] : [],
  };
}
