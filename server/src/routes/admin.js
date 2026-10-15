// POST /api/admin/reseed: reset the demo graph (header x-admin-secret must match ADMIN_SECRET).
// Runs the same scripts/seed.js as `npm run seed`, in a child process, so the server and the
// CLI share one code path. Refuses to run with the example secret or no secret configured.
import { Router } from 'express';
import { execFile } from 'node:child_process';
import { timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
export const adminRouter = Router();

function secretOk(given) {
  const expected = process.env.ADMIN_SECRET;
  if (!expected || expected === 'change-me' || typeof given !== 'string') return false;
  const a = Buffer.from(given), b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b); // constant-time compare
}

adminRouter.post('/admin/reseed', (req, res) => {
  if (!secretOk(req.get('x-admin-secret'))) return res.status(403).json({ error: 'forbidden' });
  execFile('node', ['scripts/seed.js'], { cwd: ROOT, env: process.env, timeout: 60000 }, (err, stdout, stderr) => {
    if (err) return res.status(500).json({ error: 'reseed failed', detail: stderr.slice(-500) });
    res.json({ ok: true, log: stdout.trim().split('\n').at(-1) });
  });
});
