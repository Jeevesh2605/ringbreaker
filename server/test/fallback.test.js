// Model fallback in the agent loop, driven by a fake Groq client: no DB, no API, no tokens.
// The fake fails the primary model with Groq's real daily-quota 429 text and answers the
// fallback model with an immediate submit_verdict.
import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import Groq from 'groq-sdk';
import { investigate, isDailyQuotaError } from '../src/agent/loop.js';
import { close } from '../src/db.js';

after(() => close()); // the ITPM test runs a real read tool, which opens a DB connection

const quota429 = (model, unit = 'tokens per day (TPD)') => new Groq.RateLimitError(429,
  { error: { message: `Rate limit reached for model \`${model}\` on ${unit}: Limit 200000, Used 198485, Requested 3864.` } },
  undefined, new Headers());

const submit = {
  choices: [{ finish_reason: 'tool_calls', message: { content: '', tool_calls: [{ id: 'c1', type: 'function',
    function: { name: 'submit_verdict', arguments: JSON.stringify({
      verdict: 'benign', confidence: 0.8, ring_members: [], evidence: ['test'], recommended_actions: [] }) } }] } }],
  usage: { prompt_tokens: 10, completion_tokens: 5 },
};

// Fake client: records which model each request asked for; `failing` models throw `error`.
function fakeClient(failing, error = quota429) {
  const calls = [];
  return { calls, chat: { completions: { create: async (body) => {
    calls.push(body.model);
    if (failing.includes(body.model)) throw error(body.model);
    return submit;
  } } } };
}

beforeEach(() => { process.env.MODEL = 'primary'; process.env.FALLBACK_MODEL = 'backup'; });

test('switches to FALLBACK_MODEL when the daily quota runs out, and finishes the run', async () => {
  const client = fakeClient(['primary']);
  const events = [];
  const run = await investigate('ALT001', { client, onEvent: (e) => events.push(e) });
  assert.deepEqual(client.calls, ['primary', 'backup']);
  assert.deepEqual(run.models, ['primary', 'backup']);
  assert.equal(run.steps, 1); // the rejected request does not use up a step
  assert.equal(run.verdict.verdict, 'benign');
  const sw = events.find((e) => e.type === 'model_switch');
  assert.deepEqual({ from: sw.from, to: sw.to }, { from: 'primary', to: 'backup' });
});

test('stays on the primary model when it has quota', async () => {
  const client = fakeClient([]);
  const run = await investigate('ALT001', { client });
  assert.deepEqual(client.calls, ['primary']);
  assert.deepEqual(run.models, ['primary']);
});

test('fails with a clear error when every model is out of quota', async () => {
  await assert.rejects(investigate('ALT001', { client: fakeClient(['primary', 'backup']) }),
    /daily token quota exhausted for primary and backup/);
});

test('no FALLBACK_MODEL set: a daily-quota error fails the run', async () => {
  delete process.env.FALLBACK_MODEL;
  await assert.rejects(investigate('ALT001', { client: fakeClient(['primary']) }), /daily token quota exhausted for primary$/);
});

test('per-minute limits do not trigger a switch (the SDK waits those out)', async () => {
  assert.equal(isDailyQuotaError(quota429('m', 'tokens per minute (TPM)')), false);
  assert.equal(isDailyQuotaError(quota429('m', 'requests per day (RPD)')), true);
  const client = fakeClient(['primary'], (m) => quota429(m, 'tokens per minute (TPM)'));
  await assert.rejects(investigate('ALT001', { client }));
  assert.deepEqual(client.calls, ['primary']);
});

// The real error Groq returned for qwen/qwen3.8-27b with max_completion_tokens 3000 (Oct 16).
const otpm429 = (model) => new Groq.RateLimitError(429, { error: { message:
  `Request too large for model \`${model}\` in organization \`org_x\` service tier \`on_demand\` on output tokens per minute (OTPM): Limit 1000, Requested 1263. The request's expected output tokens exceed the enforced limit; reduce max_tokens (or the request's expected output) and try again.`,
  type: 'tokens', code: 'rate_limit_exceeded' } }, undefined, new Headers());

test('after a switch, lowers max_completion_tokens to the fallback model\'s OTPM limit', async () => {
  const sent = [];
  const client = { chat: { completions: { create: async (body) => {
    sent.push([body.model, body.max_completion_tokens]);
    if (body.model === 'primary') throw quota429('primary');
    if (body.max_completion_tokens > 1000) throw otpm429('backup');
    return submit;
  } } } };
  const run = await investigate('ALT001', { client });
  assert.deepEqual(sent, [['primary', 3000], ['backup', 3000], ['backup', 1000]]);
  assert.equal(run.verdict.verdict, 'benign');
  assert.equal(run.steps, 1);
});

test('gives up if the request is still too large after capping', async () => {
  const client = { chat: { completions: { create: async () => { throw otpm429('primary'); } } } };
  await assert.rejects(investigate('ALT001', { client }), /Request too large/);
});

// The real 413 Groq returned for qwen/qwen3.8-27b during the Oct 16 eval (ALT003, step 3).
const itpm413 = (model, requested) => new Groq.APIError(413, { error: { message:
  `Request too large for model \`${model}\` in organization \`org_x\` service tier \`on_demand\` on input tokens per minute (ITPM): Limit 7000, Requested ${requested}, please reduce your message size and try again.`,
  type: 'tokens', code: 'rate_limit_exceeded' } }, undefined, new Headers());

// A real read tool call (read-only, local FalkorDB): its result is large, as in a real run.
const trailTurn = (id) => ({
  choices: [{ finish_reason: 'tool_calls', message: { content: '', tool_calls: [{ id, type: 'function',
    function: { name: 'money_trail', arguments: JSON.stringify({ account_id: 'ACC0438', direction: 'forward', max_hops: 4 }) } }] } }],
  usage: { prompt_tokens: 10, completion_tokens: 5 },
});

test('input too large (ITPM 413): trims older tool results and redoes the step', async () => {
  const sent = [];
  const client = { chat: { completions: { create: async (body) => {
    sent.push(JSON.stringify(body.messages));
    const n = sent.length;
    if (n <= 3) return trailTurn(`c${n}`);       // steps 1-3 call money_trail, growing the context
    if (n === 4) throw itpm413('primary', 7617);  // step 4 is rejected as too large
    return submit;                                // the retried step 4 submits
  } } } };
  const events = [];
  const run = await investigate('ALT001', { client, onEvent: (e) => events.push(e) });
  assert.equal(run.verdict.verdict, 'benign');
  assert.equal(run.steps, 4); // the rejected request does not use up a step
  assert.ok(events.some((e) => e.type === 'retry' && /input tokens per minute/.test(e.reason)));
  const trimmed = (m) => (m.match(/older result trimmed/g) ?? []).length;
  assert.ok(trimmed(sent[4]) > trimmed(sent[3]), 'the retry trims more older results');
  assert.ok(sent[4].length < sent[3].length, 'the retried request is smaller');
});

test('tooLargeFromError reads both input and output variants', async () => {
  const { tooLargeFromError } = await import('../src/agent/loop.js');
  assert.deepEqual(tooLargeFromError(itpm413('m', 7617)), { kind: 'input', limit: 7000, requested: 7617 });
  assert.deepEqual(tooLargeFromError(otpm429('m')), { kind: 'output', limit: 1000, requested: 1263 });
  assert.equal(tooLargeFromError(quota429('m')), null);
});
