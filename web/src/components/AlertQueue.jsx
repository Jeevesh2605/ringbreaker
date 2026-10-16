// Left pane: the alert queue. Clicking an alert starts an investigation.
// Alert summaries come from graph data, so they are rendered as plain text (React escapes it).
const TYPE_LABEL = { victim_complaint: 'Victim complaint', velocity: 'Velocity', fan_in: 'Fan-in' };

export default function AlertQueue({ alerts, selected, busy, onPick, error }) {
  return (
    <aside className="pane alerts">
      <h2>Alerts</h2>
      {error && <p className="err">{error}</p>}
      <ul>
        {alerts.map((a) => (
          <li key={a.id}>
            <button className={a.id === selected ? 'alert sel' : 'alert'} disabled={busy} onClick={() => onPick(a)}>
              <span className="row"><b>{a.id}</b><span className={`tag ${a.type}`}>{TYPE_LABEL[a.type] ?? a.type}</span></span>
              <span className="summary">{a.summary}</span>
              <span className="meta">{a.account_id} · {a.account_status}</span>
            </button>
          </li>
        ))}
      </ul>
    </aside>
  );
}
