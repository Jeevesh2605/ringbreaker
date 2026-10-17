// POST /api/actions/approve {caseId, actions: [accountId, ...], approvedBy}
// The approval gate: the ONLY path in the system that freezes accounts (SPEC 8.4).
//   1. verify_cutoff before (how many money routes are open now)
//   2. freeze_account for each approved id. freeze_account itself refuses ids the case
//      did not propose, so the client can't approve something the agent never proposed.
//   3. verify_cutoff after: the before/after numbers are the demo's proof. `cut` is true only
//      if no route remains AND no ring money sits in an active account outside the case
//      (the leak check in verifyCutoff.js).
//   4. close_case records the outcome on the Case: 'closed' if cut, else 'needs_review'.
//      The alert queue derives each alert's status from its latest Case (routes/alerts.js).
// No auth (non-goal in SPEC 2): approvedBy is a name typed in the UI, stored on every
// audit edge.
import { Router } from 'express';
import { requirePasscode } from '../passcode.js';
import { actions } from '../tools/index.js';

export const actionsRouter = Router();

actionsRouter.post('/actions/approve', requirePasscode, async (req, res, next) => {
  try {
    const { caseId, approvedBy } = req.body ?? {};
    // Accept ["ACC1", ...] or [{account_id: "ACC1"}, ...].
    const ids = (req.body?.actions ?? []).map((a) => (typeof a === 'string' ? a : a?.account_id));
    if (typeof caseId !== 'string' || !caseId) return res.status(400).json({ error: 'caseId is required' });
    if (typeof approvedBy !== 'string' || !approvedBy.trim()) return res.status(400).json({ error: 'approvedBy is required' });
    if (!ids.length || ids.some((id) => typeof id !== 'string')) return res.status(400).json({ error: 'actions must list account ids' });

    const before = await actions.verify_cutoff({ case_id: caseId });
    const results = [];
    for (const account_id of ids) {
      const r = await actions.freeze_account({ case_id: caseId, account_id, approved_by: approvedBy.trim(), reason: 'approved from case review' });
      results.push({ account_id, frozen: r.data.frozen, summary: r.summary });
    }
    const after = await actions.verify_cutoff({ case_id: caseId });
    // Only record an outcome if something was actually frozen by this approval; a request whose
    // freezes were all refused (unknown case, already frozen) must not close anything.
    const closed = results.some((r) => r.frozen)
      ? await actions.close_case({ case_id: caseId, cut: after.data.cut === true })
      : null;
    res.json({
      caseId,
      results,
      case_status: closed?.data.status ?? null,
      verify: {
        before: before.data.routes, after: after.data.routes,
        before_summary: before.summary, after_summary: after.summary,
        cypher: after.cypher, remaining_sample: after.data.sample_routes ?? [],
        leaks: after.data.leaks ?? 0, leaked_amount: after.data.leaked_amount ?? 0,
        leak_accounts: after.data.leak_accounts ?? [], cut: after.data.cut ?? false,
      },
    });
  } catch (e) { next(e); }
});
