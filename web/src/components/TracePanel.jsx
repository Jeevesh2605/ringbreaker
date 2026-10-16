// Right pane, top: one row per agent step (tool, result summary, timing) with a toggle that
// reveals the exact Cypher the tool ran, so a judge can see the graph query behind each claim.
import { useState } from 'react';

function Step({ e }) {
  const [open, setOpen] = useState(false);
  return (
    <li className="step">
      <div className="row">
        <span className="num">{e.step}</span>
        <code className="tool">{e.tool}</code>
        <span className="ms">{e.ms != null ? `${(e.ms / 1000).toFixed(1)}s` : ''}</span>
      </div>
      {e.args && Object.keys(e.args).length > 0 && <div className="args">{JSON.stringify(e.args)}</div>}
      <div className="summary">{e.summary}</div>
      {e.cypher && (
        <>
          <button className="link" onClick={() => setOpen(!open)}>{open ? 'Hide Cypher' : 'Show Cypher'}</button>
          {open && <pre className="cypher">{e.cypher.trim()}</pre>}
        </>
      )}
    </li>
  );
}

export default function TracePanel({ events, running, elapsed }) {
  return (
    <section className="trace">
      <h2>Agent trace {running && <span className="live">running · {elapsed}s</span>}</h2>
      {!events.length && !running && <p className="muted">The agent's tool calls will stream in here.</p>}
      <ol>
        {events.map((e, i) =>
          e.type === 'tool' ? <Step key={i} e={e} />
          : e.type === 'error' ? <li key={i} className="note err">Error: {e.message}</li>
          : e.type === 'model_switch' ? <li key={i} className="note">Switched model {e.from} → {e.to}: {e.reason}</li>
          : e.type === 'retry' ? <li key={i} className="note">Retrying: {e.reason}</li>
          : e.type === 'verdict_rejected' ? <li key={i} className="note">Verdict rejected by validation: {e.errors?.join('; ')}</li>
          : null,
        )}
      </ol>
      {running && <p className="muted small">Free-tier rate limits can pause a run for up to a minute between steps.</p>}
    </section>
  );
}
