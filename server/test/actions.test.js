// Action tools end to end: create case -> verify (>0) -> approved freezes -> verify (0).
// Runs against a SEPARATE graph (ring_test) seeded fresh, so it never touches the demo graph.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

process.env.FALKORDB_GRAPH = 'ring_test';
const ROOT = new URL('../../', import.meta.url).pathname;
const { actions } = await import('../src/tools/index.js');
const { readQuery, getGraph, close } = await import('../src/db.js');
const gt = JSON.parse(readFileSync(`${ROOT}data/ground_truth.json`, 'utf8'));
const A = gt.rings.A;

// A verdict shaped exactly like the agent's validated output, for Ring A.
const verdict = {
  verdict: 'ring_confirmed', confidence: 0.9, evidence: ['test'],
  ring_members: A.members,
  recommended_actions: A.freeze.map((id) => ({ tool: 'freeze_account', account_id: id, reason: 'mule' })),
};
let caseId;

before(() => execFileSync('node', ['scripts/seed.js'], { cwd: ROOT, env: { ...process.env, FALKORDB_GRAPH: 'ring_test' } }));
after(async () => { await (await getGraph()).delete(); await close(); });

test('create_case links every member with its role', async () => {
  const r = await actions.create_case({ alert_id: 'ALT001', verdict });
  caseId = r.data.case_id;
  assert.equal(r.data.linked, A.members.length);
});

test('verify before freeze finds routes', async () => {
  const r = await actions.verify_cutoff({ case_id: caseId });
  assert.ok(r.data.routes > 0, r.summary);
  console.log('   before:', r.summary);
});

test('freeze refuses an account the case did not propose (a victim)', async () => {
  const victim = A.members.find((m) => m.role === 'victim').account_id;
  const r = await actions.freeze_account({ case_id: caseId, account_id: victim, approved_by: 'tester' });
  assert.equal(r.data.frozen, false);
  const [row] = await readQuery('MATCH (a:Account {id:$id}) RETURN a.status AS s', { id: victim });
  assert.equal(row.s, 'active');
});

test('freeze requires a named approver', async () => {
  await assert.rejects(actions.freeze_account({ case_id: caseId, account_id: A.freeze[0], approved_by: '' }), /approved_by/);
});

test('approved freezes cut every route, with an audit edge each', async () => {
  for (const id of A.freeze) {
    const r = await actions.freeze_account({ case_id: caseId, account_id: id, reason: 'mule', approved_by: 'tester' });
    assert.equal(r.data.frozen, true, r.summary);
  }
  const again = await actions.freeze_account({ case_id: caseId, account_id: A.freeze[0], approved_by: 'tester' });
  assert.equal(again.data.frozen, false, 'second freeze is a no-op');
  const r = await actions.verify_cutoff({ case_id: caseId });
  assert.equal(r.data.routes, 0, r.summary);
  console.log('   after: ', r.summary);
  const [audit] = await readQuery('MATCH (:Case {id:$id})-[x:ACTION]->() RETURN count(x) AS n, collect(DISTINCT x.approved_by) AS by', { id: caseId });
  assert.equal(audit.n, A.freeze.length);
  assert.deepEqual(audit.by, ['tester']);
});
