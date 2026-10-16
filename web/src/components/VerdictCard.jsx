// Right pane, bottom: the agent's verdict and the human approval gate.
// Nothing is frozen until a person ticks accounts, types their name and presses Approve; the
// server then refuses any account the agent's case did not propose (routes/actions.js).
import { useEffect, useState } from 'react';
import VerifyBadge from './VerifyBadge.jsx';

const VERDICT_LABEL = { ring_confirmed: 'Ring confirmed', suspicious: 'Suspicious: monitor', benign: 'Benign' };

export default function VerdictCard({ verdict, caseId, onApprove, approval, onReport }) {
  const recs = verdict.recommended_actions ?? [];
  const [picked, setPicked] = useState(() => new Set(recs.map((r) => r.account_id)));
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => setPicked(new Set(recs.map((r) => r.account_id))), [verdict]); // new run, reset

  const toggle = (id) => setPicked((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });
  const submit = async () => { setBusy(true); try { await onApprove([...picked], name.trim()); } finally { setBusy(false); } };

  return (
    <section className="verdict">
      <div className="row">
        <span className={`badge ${verdict.verdict}`}>{VERDICT_LABEL[verdict.verdict] ?? verdict.verdict}</span>
        <span className="muted">confidence {Math.round(verdict.confidence * 100)}%</span>
        {caseId && <span className="muted">{caseId}</span>}
      </div>

      {verdict.ring_members?.length > 0 && (
        <>
          <h3>Ring members ({verdict.ring_members.length})</h3>
          <ul className="members">
            {verdict.ring_members.map((m) => <li key={m.account_id}><code>{m.account_id}</code> <span className={`role ${m.role}`}>{m.role}</span></li>)}
          </ul>
        </>
      )}

      <h3>Evidence</h3>
      <ul className="evidence">{verdict.evidence.map((e, i) => <li key={i}>{e}</li>)}</ul>

      <h3>Recommended actions</h3>
      {!recs.length ? <p className="muted">No freeze recommended.</p> : (
        <>
          <ul className="recs">
            {recs.map((r) => (
              <li key={r.account_id}>
                <label>
                  <input type="checkbox" checked={picked.has(r.account_id)} disabled={!!approval} onChange={() => toggle(r.account_id)} />
                  Freeze <code>{r.account_id}</code> <span className="muted">{r.reason}</span>
                </label>
              </li>
            ))}
          </ul>
          {!approval && (
            <div className="approve">
              <input placeholder="Your name (audit log)" value={name} onChange={(e) => setName(e.target.value)} />
              <button className="primary" disabled={busy || !name.trim() || !picked.size || !caseId} onClick={submit}>
                {busy ? 'Freezing…' : `Approve freeze (${picked.size})`}
              </button>
            </div>
          )}
        </>
      )}

      {approval?.error && <p className="err">{approval.error}</p>}
      {approval?.verify && <VerifyBadge verify={approval.verify} />}
      {caseId && <button className="secondary" onClick={onReport}>View report</button>}
    </section>
  );
}
