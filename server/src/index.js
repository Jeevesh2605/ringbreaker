// Express API (SPEC section 9). Run: npm start (from server/), reads ../.env.
import express from 'express';
import { ensureIndexes } from './schema.js';
import { alertsRouter } from './routes/alerts.js';
import { investigateRouter } from './routes/investigate.js';
import { actionsRouter } from './routes/actions.js';
import { graphRouter } from './routes/graph.js';
import { adminRouter } from './routes/admin.js';

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '50kb' }));

app.get('/api/health', (req, res) => res.json({ ok: true }));
app.use('/api', alertsRouter, investigateRouter, actionsRouter, graphRouter, adminRouter);

app.use('/api', (req, res) => res.status(404).json({ error: 'not found' }));
// Errors: log the detail server-side, return a generic message (no stack traces to clients).
app.use((err, req, res, next) => {
  console.error(err);
  if (res.headersSent) return next(err);
  res.status(err.status ?? 500).json({ error: err.expose ? err.message : 'internal error' });
});

await ensureIndexes();
const port = Number(process.env.PORT || 8080);
app.listen(port, () => console.log(`RingBreaker API on http://localhost:${port}`));
