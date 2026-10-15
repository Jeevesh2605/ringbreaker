// validateVerdict: the grounding rules the JSON schema can't express. No DB or API needed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateVerdict } from '../src/agent/verdict.js';

const touched = new Set(['ACC1', 'ACC2', 'ACC3', 'ACC9']);
const good = {
  verdict: 'ring_confirmed',
  confidence: 0.9,
  ring_members: [{ account_id: 'ACC9', role: 'victim' }, { account_id: 'ACC1', role: 'layer' }, { account_id: 'ACC2', role: 'cashout' }],
  evidence: ['ACC1 forwarded 97% of 25,000 within 3h'],
  recommended_actions: [{ tool: 'freeze_account', account_id: 'ACC1', reason: 'layer mule' }],
};
const withChange = (patch) => ({ ...structuredClone(good), ...patch });

test('accepts a grounded verdict', () => assert.equal(validateVerdict(good, touched).ok, true));

const bad = [
  ['hallucinated member', { ring_members: [...good.ring_members, { account_id: 'ACC404', role: 'layer' }] }, /never returned/],
  ['freezing a victim', { recommended_actions: [{ tool: 'freeze_account', account_id: 'ACC9', reason: 'x' }] }, /victim/],
  ['freezing a non-member', { recommended_actions: [{ tool: 'freeze_account', account_id: 'ACC3', reason: 'x' }] }, /not in ring_members/],
  ['freeze on suspicious', { verdict: 'suspicious' }, /no freeze actions/],
  ['confidence out of range', { confidence: 1.5 }, /confidence/],
  ['empty evidence', { evidence: [] }, /evidence/],
  ['duplicate member', { ring_members: [...good.ring_members, { account_id: 'ACC1', role: 'layer' }] }, /twice/],
  ['bad verdict value', { verdict: 'maybe' }, /verdict must be/],
];
for (const [name, patch, re] of bad) {
  test(`rejects: ${name}`, () => {
    const r = validateVerdict(withChange(patch), touched);
    assert.equal(r.ok, false);
    assert.match(r.errors.join(' | '), re);
  });
}
test('benign with no members/actions is fine', () => {
  assert.equal(validateVerdict({ verdict: 'benign', confidence: 0.8, ring_members: [], evidence: ['merchant'], recommended_actions: [] }, touched).ok, true);
});
