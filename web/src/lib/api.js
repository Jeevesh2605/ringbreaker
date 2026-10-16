// REST + SSE client for the RingBreaker API (SPEC section 9).
// Dev: requests go to /api on the Vite server, which proxies to Express (vite.config.js).
// Deploy: set VITE_API_URL to the API origin, e.g. https://ringbreaker-api.example.com
const BASE = (import.meta.env.VITE_API_URL ?? '').replace(/\/$/, '');

async function json(res) {
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
  return body;
}

export const getAlerts = () => fetch(`${BASE}/api/alerts`).then(json);

export const getSubgraph = (ids) =>
  fetch(`${BASE}/api/graph/subgraph?nodeIds=${encodeURIComponent(ids.join(','))}`).then(json);

export const approve = (caseId, accountIds, approvedBy) =>
  fetch(`${BASE}/api/actions/approve`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ caseId, actions: accountIds, approvedBy }),
  }).then(json);

export async function getReport(caseId) {
  const res = await fetch(`${BASE}/api/case/${encodeURIComponent(caseId)}/report`);
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? `HTTP ${res.status}`);
  return res.text();
}

// POST /api/investigate answers with an SSE stream. EventSource can't send a POST, so we
// read the body with fetch and split it ourselves: events are separated by a blank line,
// each data line starts with "data: ", and lines starting with ":" are keep-alive comments.
export async function investigate(alertId, onEvent, signal) {
  const res = await fetch(`${BASE}/api/investigate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ alertId }),
    signal,
  });
  if (!res.ok) await json(res); // throws with the server's error message (e.g. 409 busy)

  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  let buf = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += value;
    let cut;
    while ((cut = buf.indexOf('\n\n')) !== -1) {
      const block = buf.slice(0, cut);
      buf = buf.slice(cut + 2);
      const data = block.split('\n').filter((l) => l.startsWith('data: ')).map((l) => l.slice(6)).join('\n');
      if (data) onEvent(JSON.parse(data));
    }
  }
}
