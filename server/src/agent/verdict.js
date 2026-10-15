// Verdict schema (SPEC 8.1) and validation.
//
// The model finishes by calling the submit_verdict tool. The provider does not guarantee
// the arguments match the schema, so validateVerdict() checks everything itself: types,
// enums, and the rules a schema can't express, such as "every ring member must be an
// account the tools actually returned", so the agent can't name accounts it never saw.
//
// `touched` is NOT produced by the model: the loop fills it from the trace (what the
// tools really returned), so the highlighted subgraph is always grounded.

export const VERDICTS = ['ring_confirmed', 'suspicious', 'benign'];
export const ROLES = ['victim', 'layer', 'collector', 'cashout'];

export const SUBMIT_VERDICT_TOOL = {
  name: 'submit_verdict',
  description: 'Submit the final investigation verdict. Call exactly once, as the last step.',
  input_schema: {
    type: 'object',
    properties: {
      verdict: { type: 'string', enum: VERDICTS },
      confidence: { type: 'number', description: '0.0 to 1.0' },
      ring_members: {
        type: 'array',
        items: {
          type: 'object',
          properties: { account_id: { type: 'string' }, role: { type: 'string', enum: ROLES } },
          required: ['account_id', 'role'],
          additionalProperties: false,
        },
      },
      evidence: { type: 'array', items: { type: 'string' }, description: 'Plain-language reasons citing graph facts' },
      recommended_actions: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            tool: { type: 'string', enum: ['freeze_account'] },
            account_id: { type: 'string' },
            reason: { type: 'string' },
          },
          required: ['tool', 'account_id', 'reason'],
          additionalProperties: false,
        },
      },
    },
    required: ['verdict', 'confidence', 'ring_members', 'evidence', 'recommended_actions'],
    additionalProperties: false,
  },
};

// Returns { ok: true, verdict } or { ok: false, errors: [...] }.
// touchedNodes: Set of node ids the tools returned during this run.
export function validateVerdict(input, touchedNodes) {
  const errors = [];
  const v = input ?? {};
  if (!VERDICTS.includes(v.verdict)) errors.push(`verdict must be one of ${VERDICTS.join(', ')}`);
  if (typeof v.confidence !== 'number' || v.confidence < 0 || v.confidence > 1) errors.push('confidence must be a number in [0, 1]');
  if (!Array.isArray(v.ring_members)) errors.push('ring_members must be an array');
  if (!Array.isArray(v.evidence) || !v.evidence.length || v.evidence.some((e) => typeof e !== 'string' || !e.trim())) {
    errors.push('evidence must be a non-empty array of non-empty strings');
  }
  if (!Array.isArray(v.recommended_actions)) errors.push('recommended_actions must be an array');
  if (errors.length) return { ok: false, errors };

  const isObj = (x) => x && typeof x === 'object' && !Array.isArray(x);
  if (v.ring_members.some((m) => !isObj(m) || typeof m.account_id !== 'string')) errors.push('each ring member needs a string account_id and a role');
  if (v.recommended_actions.some((a) => !isObj(a) || a.tool !== 'freeze_account' || typeof a.account_id !== 'string' || typeof a.reason !== 'string')) {
    errors.push("each action needs tool='freeze_account', a string account_id and a reason");
  }
  if (errors.length) return { ok: false, errors };

  const roleOf = new Map();
  for (const m of v.ring_members) {
    if (!ROLES.includes(m.role)) errors.push(`${m.account_id}: invalid role ${m.role}`);
    if (roleOf.has(m.account_id)) errors.push(`${m.account_id} listed twice in ring_members`);
    if (!touchedNodes.has(m.account_id)) errors.push(`${m.account_id} was never returned by a tool in this investigation`);
    roleOf.set(m.account_id, m.role);
  }
  if (v.verdict === 'ring_confirmed' && v.ring_members.length < 2) errors.push('ring_confirmed needs at least 2 ring_members');
  if (v.verdict !== 'ring_confirmed' && v.recommended_actions.length) {
    errors.push(`no freeze actions allowed when verdict is ${v.verdict}`);
  }
  for (const a of v.recommended_actions) {
    if (!roleOf.has(a.account_id)) errors.push(`freeze target ${a.account_id} is not in ring_members`);
    else if (roleOf.get(a.account_id) === 'victim') errors.push(`freeze target ${a.account_id} is a victim; never freeze victims`);
  }
  return errors.length ? { ok: false, errors } : { ok: true, verdict: v };
}
