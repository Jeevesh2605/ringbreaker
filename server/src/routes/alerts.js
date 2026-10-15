// GET /api/alerts: the alert queue for the left pane, newest first, with the target account.
import { Router } from 'express';
import { readQuery } from '../db.js';

const CYPHER = `
MATCH (al:Alert)-[:ABOUT]->(a:Account)
RETURN al.id AS id, al.type AS type, al.created_at AS created_at, al.summary AS summary,
       a.id AS account_id, a.status AS account_status
ORDER BY al.created_at DESC`;

export const alertsRouter = Router();

alertsRouter.get('/alerts', async (req, res, next) => {
  try {
    const rows = await readQuery(CYPHER);
    res.json(rows.map((r) => ({ ...r, created_at: new Date(r.created_at).toISOString() })));
  } catch (e) { next(e); }
});
