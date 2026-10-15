// POST /api/investigate {alertId}: runs the agent and streams its trace as Server-Sent Events.
//
// Event stream (each line "data: <json>"):
//   {type:'start', alertId}
//   {type:'tool', step, tool, args, cypher, summary, nodes, edges, ms}   one per tool call
//   {type:'retry' | 'verdict_rejected', ...}                             loop housekeeping
//   {type:'verdict', verdict, caseId}   final; the verdict is saved as a Case for approval
//   {type:'error', message}
//
// POST + SSE: the browser's EventSource only does GET, so the UI reads this with fetch().
// Only ONE investigation runs at a time: the Groq free tier allows ~8K tokens/minute, and two
// parallel runs would just throttle each other.
import { Router } from 'express';
import { investigate } from '../agent/loop.js';
import { actions } from '../tools/index.js';

export const investigateRouter = Router();
let running = null; // alertId of the run in progress

investigateRouter.post('/investigate', async (req, res) => {
  const alertId = req.body?.alertId;
  if (typeof alertId !== 'string' || !/^ALT\d+$/.test(alertId)) return res.status(400).json({ error: 'alertId like ALT001 is required' });
  if (running) return res.status(409).json({ error: `investigation of ${running} already running` });
  running = alertId;

  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  const send = (event) => res.write(`data: ${JSON.stringify(event)}\n\n`);
  // Comment lines keep proxies from closing the stream during long rate-limit waits.
  const heartbeat = setInterval(() => res.write(': keep-alive\n\n'), 15000);
  // If the browser goes away, cancel the run so we stop spending tokens.
  // ('close' on the response, not the request: the request "closes" as soon as its body is read.)
  const cancel = new AbortController();
  res.on('close', () => cancel.abort());

  try {
    send({ type: 'start', alertId });
    const run = await investigate(alertId, {
      signal: cancel.signal,
      // The final verdict is sent below, together with its caseId.
      onEvent: (e) => { if (e.type !== 'verdict' && e.type !== 'error') send(e); },
    });
    const kase = await actions.create_case({ alert_id: alertId, verdict: run.verdict });
    send({ type: 'verdict', verdict: run.verdict, caseId: kase.data.case_id, steps: run.steps, usage: run.usage, ms: run.ms });
  } catch (e) {
    send({ type: 'error', message: e.message });
  } finally {
    clearInterval(heartbeat);
    running = null;
    res.end();
  }
});
