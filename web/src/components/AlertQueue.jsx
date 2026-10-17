// Left pane: the alert queue. Clicking an alert starts an investigation.
// Alert summaries come from graph data, so they are rendered as plain text (React escapes it).
const TYPE_LABEL = { victim_complaint: 'Victim complaint', velocity: 'Velocity', fan_in: 'Fan-in' };

export default function AlertQueue({ alerts, selected, busy, onPick, error, onRetry }) {
  return (
    <aside className="pane alerts">
      <div className="pane-head"><h2>Alerts {alerts.length > 0 && <span className="count">{alerts.length}</span>}</h2></div>
      {error && <p className="err">{error} <button className="link" onClick={onRetry}>Retry</button></p>}
      <ul>
        {alerts.map((a) => (
          <li key={a.id}>
            <button className={`alert ${a.type}${a.id === selected ? ' sel' : ''}`} disabled={busy} onClick={() => onPick(a)}>
              <span className="row"><b>{a.id}</b><span className={`tag ${a.type}`}>{TYPE_LABEL[a.type] ?? a.type}</span></span>
              <span className="summary">{a.summary}</span>
              <span className="meta"><code>{a.account_id}</code><span className={`status ${a.account_status}`}>{a.account_status}</span></span>
            </button>
          </li>
        ))}
      </ul>
    </aside>
  );
}
