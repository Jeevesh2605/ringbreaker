// generate_report(case_id): markdown investigation report, built ONLY from graph data:
// the case, its members and roles, the agent's evidence, the alert, every approved action
// (with approver and time), and a live verify_cutoff result.
//
// Deviation from SPEC 8.4 ("model-written"): the report is a template, not LLM prose. That
// keeps it grounded by construction (nothing appears that isn't in the graph) and costs no
// tokens on the Groq free tier. The agent's own words are already in the evidence bullets.
import { readQuery } from '../db.js';
import { verifyCutoff } from './verifyCutoff.js';

// One row per case member: role, account facts, and the freeze action if any.
// OPTIONAL MATCHes keep the case row even with no alert link or no actions yet.
const CYPHER = `
MATCH (c:Case {id: $case_id})
OPTIONAL MATCH (al:Alert {id: c.alert_id})
OPTIONAL MATCH (c)-[i:INCLUDES]->(a:Account)
OPTIONAL MATCH (c)-[x:ACTION]->(a)
RETURN properties(c) AS c, properties(al) AS alert, i.role AS role, properties(a) AS account,
       x.type AS action, x.ts AS action_ts, x.approved_by AS approved_by, x.reason AS reason
ORDER BY role, account.id`;

const ROLE_ORDER = ['victim', 'layer', 'collector', 'cashout'];
const iso = (ms) => (ms ? new Date(ms).toISOString().replace('.000Z', 'Z') : '-');
// Graph text is untrusted: keep it from breaking out of a markdown table cell.
const cell = (v) => String(v ?? '-').replace(/[|\n\r]/g, ' ');

export async function generateReport({ case_id }) {
  if (typeof case_id !== 'string') throw new Error('case_id is required');
  const rows = await readQuery(CYPHER, { case_id });
  if (!rows.length) throw new Error(`case ${case_id} not found`);
  const { c, alert } = rows[0];
  const members = rows.filter((r) => r.account)
    .sort((a, b) => ROLE_ORDER.indexOf(a.role) - ROLE_ORDER.indexOf(b.role) || a.account.id.localeCompare(b.account.id));
  const actions = members.filter((m) => m.action).sort((a, b) => a.action_ts - b.action_ts);
  const verify = await verifyCutoff({ case_id });

  const md = [
    `# Investigation report ${c.id}`,
    '',
    '_Synthetic data. Generated from the RingBreaker graph; every fact below is a stored graph value._',
    '',
    `- **Alert:** ${cell(alert?.id)} (${cell(alert?.type)}), raised ${iso(alert?.created_at)}`,
    `- **Alert text:** ${cell(alert?.summary)}`,
    `- **Verdict:** ${c.verdict} (confidence ${c.confidence})`,
    `- **Case opened:** ${iso(c.created_at)}`,
    '',
    '## Accounts',
    '',
    '| Account | Role | KYC | Opened | Status |',
    '|---|---|---|---|---|',
    ...members.map((m) => `| ${m.account.id} | ${m.role} | ${m.account.kyc_level} | ${iso(m.account.created_at).slice(0, 10)} | ${m.account.status} |`),
    '',
    '## Evidence (from the agent, citing graph facts)',
    '',
    ...(c.evidence ?? []).map((e) => `- ${cell(e)}`),
    '',
    '## Actions',
    '',
    ...(actions.length
      ? actions.map((a) => `- ${iso(a.action_ts)}: **${a.action}** ${a.account.id}, approved by ${cell(a.approved_by)}${a.reason ? ` (${cell(a.reason)})` : ''}`)
      : ['- None yet. Proposed freezes awaiting approval: ' + ((c.proposed_freezes ?? []).join(', ') || 'none')]),
    '',
    '## Cut-off verification',
    '',
    verify.data.routes === null
      ? '- Not applicable (no ring accounts in this case).'
      : [`- **${verify.data.routes}** active money route(s) remain from ${verify.data.sources} outside source(s) into ${verify.data.terminals.join(', ')}.`,
        verify.data.leaks
          ? `- **Leak:** ${verify.data.leaks} active account(s) outside this case received ${verify.data.leaked_amount} from the ring: ${verify.data.leak_accounts.join(', ')}. Review before closing.`
          : '- Leak check: no ring money went to an active account outside this case.'].join('\n'),
  ].join('\n');

  return {
    cypher: CYPHER, params: { case_id }, data: { markdown: md },
    summary: `report for ${case_id}: ${members.length} accounts, ${actions.length} actions, ${verify.data.routes ?? '-'} routes remaining`,
    nodes: members.map((m) => m.account.id), edges: [],
  };
}
