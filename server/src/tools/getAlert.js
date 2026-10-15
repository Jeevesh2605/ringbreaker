// get_alert(alert_id): the alert and the account it points at. Every investigation starts here.
import { readQuery } from '../db.js';

// Alert -[:ABOUT]-> Account. properties() returns the plain property map of a node.
const CYPHER = `
MATCH (al:Alert {id: $alert_id})-[:ABOUT]->(a:Account)
RETURN properties(al) AS alert, properties(a) AS account`;

export async function getAlert({ alert_id }) {
  if (typeof alert_id !== 'string' || !alert_id) throw new Error('alert_id (string) is required');
  const params = { alert_id };
  const rows = await readQuery(CYPHER, params);
  if (!rows.length) {
    return { cypher: CYPHER, params, data: null, summary: `alert ${alert_id} not found`, nodes: [], edges: [] };
  }
  const { alert, account } = rows[0];
  return {
    cypher: CYPHER,
    params,
    data: {
      alert: { ...alert, created_at: new Date(alert.created_at).toISOString() },
      account: { ...account, created_at: new Date(account.created_at).toISOString() },
    },
    summary: `${alert.type} alert about ${account.id}`,
    nodes: [alert.id, account.id],
    edges: [`${alert.id}>ABOUT>${account.id}`],
  };
}
