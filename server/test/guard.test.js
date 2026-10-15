// Guard tests: pure unit tests (no DB) plus one live check that RO_QUERY blocks writes.
// Run: npm test (from server/), FalkorDB must be up for the live test.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { guardCypher, MAX_LIMIT } from '../src/guard.js';
import { runReadonlyCypher } from '../src/tools/runReadonlyCypher.js';
import { readQuery, close } from '../src/db.js';

const rejects = [
  ['CREATE (:X)', 'CREATE'],
  ['MATCH (a) DETACH DELETE a RETURN 1', 'DELETE'],
  ["MATCH (a:Account) SET a.status = 'frozen' RETURN a", 'SET'],
  ['MERGE (a:Account {id:"x"}) RETURN a', 'MERGE'],
  ['MATCH (a) REMOVE a.status RETURN a', 'REMOVE'],
  ['CALL db.labels()', 'CALL'],
  ["LOAD CSV FROM 'file:///x' AS r RETURN r", 'LOAD'],
  ['DROP INDEX ON :Account(id)', 'DROP'],
  ['match (a) set a.x=1 return a', 'SET'],                                        // lower case
  ['MATCH (a) RETURN a /* harmless? */ ; CREATE (:X)', 'multiple statements'],     // statement smuggling
  ['MATCH (a) FOREACH (x IN [1] | SET a.y = 1) RETURN a', 'FOREACH'],
  ['MATCH (a) RETURN a LIMIT $n', 'literal integer'],
  ['MATCH (a)', 'RETURN'],
];
for (const [q, why] of rejects) {
  test(`rejects: ${q}`, () => {
    const r = guardCypher(q);
    assert.equal(r.ok, false);
    assert.match(r.reason, new RegExp(why, 'i'));
  });
}

test('appends LIMIT when missing', () => {
  assert.equal(guardCypher('MATCH (a:Account) RETURN a.id').query, `MATCH (a:Account) RETURN a.id LIMIT ${MAX_LIMIT}`);
});
test('caps an oversized LIMIT', () => {
  assert.equal(guardCypher('MATCH (a) RETURN a LIMIT 100000').query, `MATCH (a) RETURN a LIMIT ${MAX_LIMIT}`);
});
test('keeps a small LIMIT and strips a trailing semicolon', () => {
  assert.equal(guardCypher('MATCH (a) RETURN a LIMIT 5;').query, 'MATCH (a) RETURN a LIMIT 5');
});
test('identifiers that merely contain keywords are allowed (word boundaries)', () => {
  assert.equal(guardCypher('MATCH (a:Account) RETURN a.created_at AS offset_time').ok, true);
});

test('live: allowed query runs and returns highlighted ids', async () => {
  const r = await runReadonlyCypher({ query: "MATCH (a:Account {kyc_level:'min'}) RETURN a.id AS id LIMIT 3" });
  assert.equal(r.data.rows.length, 3);
  assert.equal(r.nodes.length, 3);
});
test('live: RO_QUERY blocks a write even with the guard bypassed (defence in depth)', async () => {
  await assert.rejects(readQuery("MATCH (a:Account {id:'ACC0001'}) SET a.status = 'frozen' RETURN a"), /read-only/);
  const [row] = await readQuery("MATCH (a:Account {id:'ACC0001'}) RETURN a.status AS s");
  assert.equal(row.s, 'active');
  await close();
});
