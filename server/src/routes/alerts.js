// GET /api/alerts: the alert queue for the left pane, newest first, with the target account
// and the alert's status, derived from its latest Case (an alert has no status of its own).
import { Router } from 'express';
import { readQuery } from '../db.js';

// Cases point back to their alert by the alert_id property (set in create_case).
// OPTIONAL MATCH keeps alerts with no case; ORDER BY + collect(c)[0] picks the newest case
// (collect skips nulls, so an alert with no case gets null, not an error), so a re-run
// investigation supersedes an older one.
const CYPHER = `
MATCH (al:Alert)-[:ABOUT]->(a:Account)
OPTIONAL MATCH (c:Case {alert_id: al.id})
WITH al, a, c ORDER BY c.created_at DESC
WITH al, a, collect(c)[0] AS c
RETURN al.id AS id, al.type AS type, al.created_at AS created_at, al.summary AS summary,
       a.id AS account_id, a.status AS account_status,
       c.id AS case_id, c.verdict AS case_verdict, c.status AS case_status
ORDER BY al.created_at DESC`;

// open: never investigated. closed: freeze approved and cut-off verified (routes 0, no leak).
// needs_review: frozen, but routes or leaks remain. awaiting_approval: ring confirmed, no
// freeze approved yet. monitoring / dismissed: suspicious / benign verdicts (no freeze).
export function alertStatus({ case_id, case_verdict, case_status }) {
  if (!case_id) return 'open';
  if (case_status === 'closed' || case_status === 'needs_review') return case_status;
  if (case_verdict === 'ring_confirmed') return 'awaiting_approval';
  return case_verdict === 'suspicious' ? 'monitoring' : 'dismissed';
}

export const alertsRouter = Router();

alertsRouter.get('/alerts', async (req, res, next) => {
  try {
    const rows = await readQuery(CYPHER);
    res.json(rows.map((r) => ({ ...r, created_at: new Date(r.created_at).toISOString(), status: alertStatus(r) })));
  } catch (e) { next(e); }
});
