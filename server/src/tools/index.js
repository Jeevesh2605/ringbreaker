// Tool registry: name -> { description, input_schema, run }.
// The schemas are what the LLM sees (JSON Schema; agent/loop.js wraps them as functions).
// Every tool returns { cypher, params, data, summary, nodes, edges }; the agent loop
// turns that into a trace event and the UI uses nodes/edges for highlighting.
//
// Edge IDs: SENT edges use their txn_id; other edges use "<from>>TYPE><to>".
//
// This registry holds READ tools only; it is exactly what the agent can call. Action tools
// (freeze etc., Day 3) live behind the approval API and are never offered to the model.
import { getAlert } from './getAlert.js';
import { accountProfile } from './accountProfile.js';
import { moneyTrail } from './moneyTrail.js';
import { fanStats } from './fanStats.js';
import { sharedIdentity } from './sharedIdentity.js';
import { expandRing } from './expandRing.js';
import { runReadonlyCypher } from './runReadonlyCypher.js';

const accountId = { type: 'string', description: 'Account id, e.g. ACC0123' };
const since = {
  type: 'string',
  description: 'ISO date, e.g. 2026-10-10. Only transactions at/after this time are considered; use it to focus on the incident window.',
};

export const tools = {
  get_alert: {
    description: 'Fetch an alert and the account it is about. Always the first step of an investigation.',
    input_schema: {
      type: 'object',
      properties: { alert_id: { type: 'string', description: 'Alert id, e.g. ALT001' } },
      required: ['alert_id'],
    },
    run: getAlert,
  },
  account_profile: {
    description: 'Account age, KYC level, status, VPAs, devices and phones (with how many accounts share each).',
    input_schema: { type: 'object', properties: { account_id: accountId }, required: ['account_id'] },
    run: accountProfile,
  },
  money_trail: {
    description: 'Follow money forward (where it went) or backward (where it came from) up to max_hops, ' +
      'returning the distinct transactions and accounts on those paths.',
    input_schema: {
      type: 'object',
      properties: {
        account_id: accountId,
        direction: { type: 'string', enum: ['forward', 'backward'] },
        max_hops: { type: 'integer', minimum: 1, maximum: 4 },
        since,
      },
      required: ['account_id', 'direction'],
    },
    run: moneyTrail,
  },
  fan_stats: {
    description: 'In/out degree, totals, inbound time span and pass-through ratio for one account.',
    input_schema: { type: 'object', properties: { account_id: accountId, since }, required: ['account_id'] },
    run: fanStats,
  },
  shared_identity: {
    description: 'Other accounts sharing a device or phone with this account, and whether they also exchange money with it.',
    input_schema: { type: 'object', properties: { account_id: accountId }, required: ['account_id'] },
    run: sharedIdentity,
  },
  expand_ring: {
    description: 'Grow a candidate ring from seed accounts via money links and shared devices/phones (1-2 hops).',
    input_schema: {
      type: 'object',
      properties: {
        seed_ids: { type: 'array', items: { type: 'string' }, minItems: 1 },
        hops: { type: 'integer', minimum: 1, maximum: 2 },
        since,
      },
      required: ['seed_ids'],
    },
    run: expandRing,
  },
  run_readonly_cypher: {
    description: 'Guarded free-form read-only Cypher, only when no specialized tool fits. ' +
      'Graph: (:Account {id,holder,created_at,kyc_level,status,balance}), (:VPA {handle}), (:Device {id,os}), ' +
      '(:Phone {number}), (:Alert {id,type,created_at,summary}); edges HAS_VPA, USES_DEVICE {last_seen}, LINKED_PHONE, ' +
      'SENT {txn_id,amount,ts}, ABOUT. Write keywords and CALL are rejected; results are capped at 100 rows. ' +
      // Seen in the Oct 16 eval (ALT003): the model compared ts to '2026-10-08', which matches
      // nothing because times are numbers, then wasted its remaining steps on empty results.
      'All times (created_at, ts, last_seen) are epoch MILLISECONDS stored as numbers: compare with numbers, ' +
      'e.g. s.ts >= 1791417600000 for 2026-10-08T00:00Z. A date string never matches.',
    input_schema: {
      type: 'object',
      properties: { query: { type: 'string', description: 'A single read-only Cypher query' } },
      required: ['query'],
    },
    run: runReadonlyCypher,
  },
};

// ACTION tools (Day 3). Deliberately NOT part of `tools` above: the agent loop only offers
// `tools` to the model, so the model can never call these. They run from the API
// (create_case after an investigation; freeze + verify + close_case after human approval).
import { createCase, closeCase } from './createCase.js';
import { freezeAccount } from './freezeAccount.js';
import { verifyCutoff } from './verifyCutoff.js';
import { generateReport } from './generateReport.js';

export const actions = {
  create_case: createCase,
  close_case: closeCase,
  freeze_account: freezeAccount,
  verify_cutoff: verifyCutoff,
  generate_report: generateReport,
};
