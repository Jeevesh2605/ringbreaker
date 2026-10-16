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

  // Node/link objects by id, kept across fetches so the layout keeps their positions.
  const store = useRef({ nodes: new Map(), links: new Map() });
  const abort = useRef(null);

  const loadAlerts = () => api.getAlerts().then(setAlerts, (e) => setAlertsError(`Could not load alerts: ${e.message}`));
  useEffect(() => { loadAlerts(); }, []);

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
      if (e.name !== 'AbortError') setEvents((ev) => [...ev, { type: 'error', message: e.message }]);
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
      setApproval({ error: e.message });
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
      </header>
      <main>
        <AlertQueue alerts={alerts} selected={alert?.id} busy={running} onPick={pick} error={alertsError} />
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
