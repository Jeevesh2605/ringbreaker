// create_case(alert_id, verdict): ACTION tool (writes). Persists the agent's verdict as a
// (:Case) node with (Case)-[:INCLUDES {role}]->(Account) edges. Called by the API after an
// investigation, never by the model. The proposed freezes are stored on the case, and
// approval can only execute freezes that appear in that list.
import { writeQuery } from '../db.js';

// One query: create the Case, then UNWIND the members and link each to its Account.
// MATCH on the indexed Account.id means unknown ids are silently skipped, never created.
const CYPHER = `
CREATE (c:Case {id: $id, alert_id: $alert_id, created_at: $now, verdict: $verdict,
                confidence: $confidence, evidence: $evidence, proposed_freezes: $proposed})
WITH c
UNWIND $members AS m
MATCH (a:Account {id: m.account_id})
CREATE (c)-[:INCLUDES {role: m.role}]->(a)
RETURN c.id AS id, count(a) AS linked`;

export async function createCase({ alert_id, verdict }) {
  if (typeof alert_id !== 'string' || !verdict?.verdict) throw new Error('alert_id and a validated verdict are required');
  const id = `CASE-${alert_id}-${Date.now().toString(36).toUpperCase()}`;
  const params = {
    id, alert_id, now: Date.now(),
    verdict: verdict.verdict, confidence: verdict.confidence, evidence: verdict.evidence,
    proposed: verdict.recommended_actions.filter((a) => a.tool === 'freeze_account').map((a) => a.account_id),
    members: verdict.ring_members,
  };
  const rows = await writeQuery(CYPHER, params);
  const linked = rows[0]?.linked ?? 0;
  // A case with no members (benign verdict) returns no rows from the UNWIND; still created.
  return {
    cypher: CYPHER, params, data: { case_id: id, linked },
    summary: `created ${id} (${verdict.verdict}) with ${linked} member(s), ${params.proposed.length} proposed freeze(s)`,
    nodes: [id, ...verdict.ring_members.map((m) => m.account_id)],
    edges: verdict.ring_members.map((m) => `${id}>INCLUDES>${m.account_id}`),
  };
}
