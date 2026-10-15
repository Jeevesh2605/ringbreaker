// Run the agent on alerts and score it against data/ground_truth.json (SPEC 7 + Day 2).
//
// Usage: npm run eval                 # all alerts
//        npm run eval -- ALT001 --trace  # one alert, printing every trace event live
//
// Scoring per alert:
//   verdict      expected vs got (ring_confirmed / suspicious / benign)
//   freeze P/R   precision/recall of recommended freezes vs the ring's true non-victim members
//   safe         no freeze recommended for the merchant, the family, or any victim
// Results are written to data/out/eval-results.json.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { investigate } from '../server/src/agent/loop.js';
import { close } from '../server/src/db.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const gt = JSON.parse(readFileSync(join(ROOT, 'data', 'ground_truth.json'), 'utf8'));

const args = process.argv.slice(2);
const showTrace = args.includes('--trace');
const alertIds = args.filter((a) => !a.startsWith('--'));
const targets = alertIds.length ? alertIds : Object.keys(gt.alerts);

// Accounts that must never be frozen: benign look-alikes and all victims of Ring A.
const neverFreeze = new Set([
  gt.benign.merchant, ...gt.benign.family,
  ...gt.rings.A.members.filter((m) => m.role === 'victim').map((m) => m.account_id),
]);

function printEvent(e) {
  if (e.type === 'tool') console.log(`   [${e.step}] ${e.tool} ${JSON.stringify(e.args)} -> ${e.summary} (${e.ms}ms)`);
  else if (e.type === 'verdict_rejected') console.log(`   [${e.step}] verdict rejected: ${e.errors.join('; ')}`);
  else if (e.type === 'retry') console.log(`   [${e.step}] retry: ${e.reason}`);
  else if (e.type === 'error') console.log(`   error: ${e.message}`);
}

const results = [];
for (const alertId of targets) {
  const expected = gt.alerts[alertId];
  if (!expected) { console.log(`${alertId}: not in ground truth, skipped`); continue; }
  console.log(`\n=== ${alertId} (expect ${expected.expected_verdict}${expected.ring ? `, ring ${expected.ring}` : ''}) ===`);
  const row = { alertId, expected: expected.expected_verdict, ring: expected.ring };
  try {
    const run = await investigate(alertId, { onEvent: showTrace ? printEvent : () => {} });
    const v = run.verdict;
    const frozen = v.recommended_actions.map((a) => a.account_id);
    const truth = new Set(expected.ring ? gt.rings[expected.ring].freeze : []);
    const hit = frozen.filter((id) => truth.has(id)).length;
    Object.assign(row, {
      got: v.verdict,
      confidence: v.confidence,
      verdict_ok: v.verdict === expected.expected_verdict,
      freeze: frozen,
      freeze_precision: frozen.length ? hit / frozen.length : (truth.size ? 0 : 1),
      freeze_recall: truth.size ? hit / truth.size : 1,
      safe: !frozen.some((id) => neverFreeze.has(id)),
      steps: run.steps,
      tool_calls: run.trace.length,
      seconds: Math.round(run.ms / 1000),
      tokens: run.usage,
      evidence: v.evidence,
      ring_members: v.ring_members,
    });
    console.log(`   verdict ${v.verdict} (${v.confidence}) ${row.verdict_ok ? 'OK' : 'WRONG'} | freeze ${frozen.length} ` +
      `P=${row.freeze_precision.toFixed(2)} R=${row.freeze_recall.toFixed(2)} | safe=${row.safe} | ` +
      `${run.steps} steps, ${run.trace.length} tool calls, ${row.seconds}s`);
    v.evidence.forEach((e) => console.log(`     - ${e}`));
  } catch (e) {
    Object.assign(row, { got: 'error', error: e.message, verdict_ok: false, safe: true });
    console.log(`   ERROR: ${e.message}`);
  }
  results.push(row);
}

console.log('\n=== summary ===');
console.table(results.map((r) => ({
  alert: r.alertId, expected: r.expected, got: r.got, ok: r.verdict_ok,
  P: r.freeze_precision?.toFixed(2), R: r.freeze_recall?.toFixed(2), safe: r.safe, steps: r.steps, s: r.seconds,
})));
const tok = results.reduce((s, r) => {
  for (const [k, v] of Object.entries(r.tokens ?? {})) s[k] = (s[k] ?? 0) + v;
  return s;
}, {});
console.log(`verdicts correct: ${results.filter((r) => r.verdict_ok).length}/${results.length}; ` +
  `unsafe freezes: ${results.filter((r) => !r.safe).length}; tokens: ${JSON.stringify(tok)}`);

mkdirSync(join(ROOT, 'data', 'out'), { recursive: true });
writeFileSync(join(ROOT, 'data', 'out', 'eval-results.json'), JSON.stringify(results, null, 2));
await close();
