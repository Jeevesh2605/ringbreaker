// The proof step (SPEC 8.4): open money routes into the ring's end account, counted by
// verify_cutoff before and after the approved freeze. "N routes, then 0" is the demo's payoff,
// but only counts as proof if the leak check also passes: no ring money may sit in an active
// account the case never named (e.g. a cash-out the agent missed). See verifyCutoff.js.
import { useState } from 'react';

const inr = (n) => `₹${Number(n ?? 0).toLocaleString('en-IN')}`;

export default function VerifyBadge({ verify }) {
  const [open, setOpen] = useState(false);
  const leaks = verify.leaks ?? 0;
  const cut = verify.cut ?? (verify.after === 0 && leaks === 0);
  const title = cut ? '✓ Cut-off verified' : verify.after === 0 ? 'Routes cut, but money leaked' : 'Routes still open';
  return (
    <div className={`verify ${cut ? 'ok' : 'warn'}`}>
      <div className="verify-title">{title}</div>
      <div className="nums">
        <div><b>{verify.before}</b><span>open routes before freeze</span></div>
        <span className="arrow">→</span>
        <div><b className="after">{verify.after}</b><span>after freeze</span></div>
      </div>
      {leaks > 0 && (
        <div className="leak">
          ⚠ {inr(verify.leaked_amount)} already left the ring to {leaks} active account(s) outside this case:{' '}
          {verify.leak_accounts.map((id) => <code key={id}>{id}</code>)}. Review them before closing the case.
        </div>
      )}
      <div className="small">
        {cut ? 'Re-queried the graph: no active money path remains, and no ring money sits in an active outside account.'
          : leaks > 0 && verify.after === 0 ? 'Leak check: no ring money may reach an active account the case did not name.'
          : verify.after_summary}
      </div>
      <button className="link" onClick={() => setOpen(!open)}>{open ? 'Hide verify Cypher' : 'Show verify Cypher'}</button>
      {open && <pre className="cypher">{verify.cypher?.trim()}</pre>}
    </div>
  );
}
