// The proof step (SPEC 8.4): open money routes from the victim to the cash-out, counted by
// verify_cutoff before and after the approved freeze. "N routes, then 0" is the demo's payoff.
import { useState } from 'react';

export default function VerifyBadge({ verify }) {
  const [open, setOpen] = useState(false);
  const cut = verify.after === 0;
  return (
    <div className={`verify ${cut ? 'ok' : 'warn'}`}>
      <div className="nums">
        <span><b>{verify.before}</b> open routes</span>
        <span className="arrow">→</span>
        <span><b>{verify.after}</b> open routes</span>
      </div>
      <div className="small">{cut ? 'Cut-off verified: no active money path remains.' : verify.after_summary}</div>
      <button className="link" onClick={() => setOpen(!open)}>{open ? 'Hide verify Cypher' : 'Show verify Cypher'}</button>
      {open && <pre className="cypher">{verify.cypher?.trim()}</pre>}
    </div>
  );
}
