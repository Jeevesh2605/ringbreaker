// Demo passcode on the costly routes. Mounts the real routers on a throwaway app; requests
// that fail the passcode are rejected before the agent or any action runs (no DB, no tokens).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { passcodeOk } from '../src/passcode.js';
import { investigateRouter } from '../src/routes/investigate.js';
import { actionsRouter } from '../src/routes/actions.js';

let server, base;
before(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api', investigateRouter, actionsRouter);
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://localhost:${server.address().port}/api`;
});
after(() => { server.close(); delete process.env.DEMO_PASSCODE; });

const post = (path, body, code) => fetch(`${base}${path}`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', ...(code != null ? { 'x-demo-passcode': code } : {}) },
  body: JSON.stringify(body),
});

test('passcodeOk: open when unset, exact match when set', () => {
  assert.equal(passcodeOk(undefined, ''), true);
  assert.equal(passcodeOk('anything', undefined), true);
  assert.equal(passcodeOk('ring-2026', 'ring-2026'), true);
  assert.equal(passcodeOk('ring-2025', 'ring-2026'), false);
  assert.equal(passcodeOk('ring', 'ring-2026'), false); // different length
  assert.equal(passcodeOk(undefined, 'ring-2026'), false);
});

for (const [path, body] of [['/investigate', { alertId: 'ALT001' }], ['/actions/approve', { caseId: 'C', actions: ['ACC1'], approvedBy: 'x' }]]) {
  test(`${path}: 401 without or with a wrong passcode`, async () => {
    process.env.DEMO_PASSCODE = 'ring-2026';
    for (const code of [null, 'wrong']) {
      const res = await post(path, body, code);
      assert.equal(res.status, 401);
      assert.equal((await res.json()).code, 'passcode');
    }
  });
}

test('the right passcode reaches the route (which then validates its body)', async () => {
  process.env.DEMO_PASSCODE = 'ring-2026';
  const inv = await post('/investigate', { alertId: 'nope' }, 'ring-2026');
  assert.equal(inv.status, 400); // past the gate, rejected by the route's own validation
  const app = await post('/actions/approve', {}, 'ring-2026');
  assert.equal(app.status, 400);
});

test('no DEMO_PASSCODE: routes are open (local dev)', async () => {
  delete process.env.DEMO_PASSCODE;
  const res = await post('/investigate', { alertId: 'nope' });
  assert.equal(res.status, 400);
});
