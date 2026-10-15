// account_profile(account_id): who/what an account is: age, KYC level, status, plus the
// VPAs, devices and phones attached to it, with how many accounts share each device/phone.
import { readQuery } from '../db.js';

const DAY = 86_400_000;

// OPTIONAL MATCH keeps the account row even if it has no VPA/device/phone.
// For each device/phone we also count how many accounts use it (shared_by), which is
// the cheapest "is this identity shared?" signal. collect(DISTINCT ...) avoids the
// row multiplication you get from chaining several OPTIONAL MATCHes.
const CYPHER = `
MATCH (a:Account {id: $account_id})
OPTIONAL MATCH (a)-[:HAS_VPA]->(v:VPA)
WITH a, collect(DISTINCT v.handle) AS vpas
OPTIONAL MATCH (a)-[:USES_DEVICE]->(d:Device)<-[:USES_DEVICE]-(du:Account)
WITH a, vpas, d, count(DISTINCT du) AS d_shared
WITH a, vpas, collect(CASE WHEN d IS NULL THEN NULL ELSE {id: d.id, os: d.os, shared_by: d_shared} END) AS devices
OPTIONAL MATCH (a)-[:LINKED_PHONE]->(p:Phone)<-[:LINKED_PHONE]-(pu:Account)
WITH a, vpas, devices, p, count(DISTINCT pu) AS p_shared
RETURN properties(a) AS account, vpas, devices,
       collect(CASE WHEN p IS NULL THEN NULL ELSE {number: p.number, shared_by: p_shared} END) AS phones`;

export async function accountProfile({ account_id }) {
  if (typeof account_id !== 'string' || !account_id) throw new Error('account_id (string) is required');
  const params = { account_id };
  const rows = await readQuery(CYPHER, params);
  if (!rows.length) {
    return { cypher: CYPHER, params, data: null, summary: `account ${account_id} not found`, nodes: [], edges: [] };
  }
  const { account, vpas, devices, phones } = rows[0];
  const ageDays = Math.floor((Date.now() - account.created_at) / DAY);
  const data = {
    account: { ...account, created_at: new Date(account.created_at).toISOString(), age_days: ageDays },
    vpas,
    devices,
    phones,
  };
  const shared = [...devices, ...phones].filter((x) => x.shared_by > 1).length;
  return {
    cypher: CYPHER,
    params,
    data,
    summary: `${account.id}: ${ageDays}d old, kyc=${account.kyc_level}, ${account.status}, ` +
      `${devices.length} device(s), ${phones.length} phone(s), ${shared} shared with other accounts`,
    nodes: [account.id, ...vpas, ...devices.map((d) => d.id), ...phones.map((p) => p.number)],
    edges: [
      ...vpas.map((h) => `${account.id}>HAS_VPA>${h}`),
      ...devices.map((d) => `${account.id}>USES_DEVICE>${d.id}`),
      ...phones.map((p) => `${account.id}>LINKED_PHONE>${p.number}`),
    ],
  };
}
