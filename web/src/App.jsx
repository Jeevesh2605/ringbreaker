// RingBreaker UI (SPEC section 10): alert queue | graph canvas | trace + verdict.
//
// Flow: pick an alert -> POST /api/investigate streams trace events -> each event's touched
// node ids are added to the canvas (fetched from /api/graph/subgraph) and glow -> the verdict
// arrives with a caseId -> a human approves the freeze -> the server freezes and re-runs
// verify_cutoff -> the badge shows routes before/after and the canvas turns frozen nodes red.
import { useEffect, useRef, useState } from 'react';
import AlertQueue from './components/AlertQueue.jsx';
import GraphCanvas from './components/GraphCanvas.jsx';
import TracePanel from './components/TracePanel.jsx';
import VerdictCard from './components/VerdictCard.jsx';
import * as api from './lib/api.js';

const MAX_IDS = 400; // the subgraph endpoint's limit
const PASS_KEY = 'ringbreaker.passcode';

// Browser storage can throw (private mode, blocked site data): it is only a convenience.
const browserStore = {
  get: (k) => { try { return localStorage.getItem(k) ?? ''; } catch { return ''; } },
  set: (k, v) => { try { v ? localStorage.setItem(k, v) : localStorage.removeItem(k); } catch { /* ignore */ } },
};

// Turn API errors into something a demo viewer can act on.
function explain(e) {
  if (e.code === 'passcode') return 'This action needs the demo passcode (top right).';
  if (e.status === 409) return `${e.message}. Only one investigation runs at a time on the free LLM tier; try again shortly.`;
  if (/daily token quota exhausted/.test(e.message)) return `${e.message}. The free LLM quota refills over the day; try again later.`;
  if (e instanceof TypeError) return 'Cannot reach the server. If the demo has been idle, it may be waking up (about a minute).';
  return e.message;
}

export default function App() {
  const [alerts, setAlerts] = useState([]);
  const [alertsError, setAlertsError] = useState(null);
  const [alert, setAlert] = useState(null);
  const [events, setEvents] = useState([]);
  const [running, setRunning] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [result, setResult] = useState(null); // {verdict, caseId}
  const [approval, setApproval] = useState(null);
  const [report, setReport] = useState(null);
  const [graph, setGraph] = useState({ nodes: [], links: [] });
  const [latest, setLatest] = useState(new Set());
  const [touched, setTouched] = useState(new Set());
  const [passRequired, setPassRequired] = useState(false);
  const [passInput, setPassInput] = useState(() => browserStore.get(PASS_KEY));
  const [passOk, setPassOk] = useState(false);
  const [notice, setNotice] = useState(null);

  // Node/link objects by id, kept across fetches so the layout keeps their positions.
  const store = useRef({ nodes: new Map(), links: new Map() });
  const abort = useRef(null);

  const loadAlerts = () => api.getAlerts().then(
    (a) => { setAlerts(a); setAlertsError(null); },
    (e) => setAlertsError(`Could not load alerts. ${explain(e)}`));
  useEffect(() => { loadAlerts(); }, []);

  // Ask the server whether a passcode is needed; re-check a remembered one.
  useEffect(() => {
    api.getConfig().then(({ passcodeRequired }) => {
      setPassRequired(passcodeRequired);
      if (passcodeRequired && passInput) unlock(passInput);
    }, () => {});
  }, []);

  async function unlock(p = passInput) {
    try {
      const { ok } = await api.checkPasscode(p);
      setPassOk(ok);
      if (ok) { api.setPasscode(p); browserStore.set(PASS_KEY, p); setNotice(null); }
      else { browserStore.set(PASS_KEY, ''); setNotice('Wrong passcode.'); }
    } catch (e) { setNotice(explain(e)); }
  }

  async function resetDemo() {
    const secret = window.prompt('Admin secret to reset the demo graph (unfreezes all accounts, removes cases):');
    if (!secret) return;
    try {
      await api.reseed(secret);
      reset(); setAlert(null); loadAlerts();
      setNotice('Demo graph reset.');
    } catch (e) { setNotice(e.status === 403 ? 'Wrong admin secret.' : explain(e)); }
  }

  useEffect(() => {
    if (!running) return;
    const start = Date.now();
    const t = setInterval(() => setElapsed(Math.round((Date.now() - start) / 1000)), 1000);
    return () => clearInterval(t);
  }, [running]);

  // Fetch the given ids plus everything already shown, then merge into the store. Existing
  // node objects are updated in place (e.g. status -> frozen) instead of replaced.
  async function addToGraph(ids) {
    const s = store.current;
    const all = [...new Set([...s.nodes.keys(), ...ids])].slice(0, MAX_IDS);
    const { nodes, edges } = await api.getSubgraph(all);
    for (const n of nodes) {
      const old = s.nodes.get(n.id);
      if (old) old.props = n.props; else s.nodes.set(n.id, { ...n });
    }
    for (const e of edges) if (!s.links.has(e.id)) s.links.set(e.id, { ...e });
    setGraph({ nodes: [...s.nodes.values()], links: [...s.links.values()] });
  }

  function reset() {
    store.current = { nodes: new Map(), links: new Map() };
    setGraph({ nodes: [], links: [] });
    setEvents([]); setResult(null); setApproval(null); setReport(null);
    setLatest(new Set()); setTouched(new Set()); setElapsed(0);
  }

  async function pick(a) {
    if (passRequired && !passOk) { setNotice('Enter the demo passcode (top right) to run an investigation.'); return; }
    setNotice(null);
    reset();
    setAlert(a);
    setRunning(true);
    abort.current = new AbortController();
    // Graph fetches run in order, so a slow one can't overwrite a newer one.
    let chain = addToGraph([a.id, a.account_id]).catch(() => {});
    try {
      await api.investigate(a.id, (e) => {
        setEvents((ev) => [...ev, e]);
        if (e.type === 'tool') {
          const ids = [...(e.nodes ?? []), ...(e.edges ?? [])];
          setLatest(new Set(ids));
          setTouched((t) => new Set([...t, ...ids, a.id]));
          if (e.nodes?.length) chain = chain.then(() => addToGraph(e.nodes)).catch(() => {});
        } else if (e.type === 'verdict') {
          setResult({ verdict: e.verdict, caseId: e.caseId });
          setLatest(new Set());
        }
      }, abort.current.signal);
    } catch (e) {
      if (e.name !== 'AbortError') setEvents((ev) => [...ev, { type: 'error', message: explain(e) }]);
    } finally {
      setRunning(false);
    }
  }

  async function doApprove(accountIds, approvedBy) {
    try {
      const r = await api.approve(result.caseId, accountIds, approvedBy);
      setApproval(r);
      await addToGraph([]); // refresh statuses: frozen accounts turn red
      loadAlerts();
    } catch (e) {
      setApproval({ error: explain(e) });
    }
  }

  async function showReport() {
    try { setReport(await api.getReport(result.caseId)); } catch (e) { setReport(`Could not load report: ${e.message}`); }
  }

  const roles = new Map((result?.verdict.ring_members ?? []).map((m) => [m.account_id, m.role]));

  return (
    <div className="app">
      <header>
        <h1>RingBreaker</h1>
        <span className="muted">Investigate a UPI mule ring, freeze it with approval, prove the cut-off. Synthetic data.</span>
        <div className="controls">
          {passRequired && (passOk ? <span className="ok-text">Passcode accepted</span> : (
            <form onSubmit={(e) => { e.preventDefault(); unlock(); }}>
              <input type="password" placeholder="Demo passcode" value={passInput} onChange={(e) => setPassInput(e.target.value)} />
              <button className="secondary" disabled={!passInput}>Unlock</button>
            </form>
          ))}
          <button className="secondary" disabled={running} onClick={resetDemo}>Reset demo</button>
        </div>
      </header>
      {notice && <div className="notice" onClick={() => setNotice(null)}>{notice}</div>}
      <main>
        <AlertQueue alerts={alerts} selected={alert?.id} busy={running} onPick={pick} error={alertsError} onRetry={loadAlerts} />
        <GraphCanvas graph={graph} latest={latest} touched={touched} roles={roles} />
        <aside className="pane right">
          {running && <button className="secondary" onClick={() => abort.current?.abort()}>Stop run</button>}
          <TracePanel events={events} running={running} elapsed={elapsed} />
          {result && <VerdictCard verdict={result.verdict} caseId={result.caseId} approval={approval} onApprove={doApprove} onReport={showReport} />}
        </aside>
      </main>
      {report && (
        <div className="modal" onClick={() => setReport(null)}>
          <div className="sheet" onClick={(e) => e.stopPropagation()}>
            <button className="secondary close" onClick={() => setReport(null)}>Close</button>
            <pre className="report">{report}</pre>
          </div>
        </div>
      )}
    </div>
  );
}
