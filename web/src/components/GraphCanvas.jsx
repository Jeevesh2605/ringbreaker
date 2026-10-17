// Center pane: the subgraph the agent has walked so far.
//
// Props:
//   graph   {nodes, links} built by App from /api/graph/subgraph. App reuses the same node
//           objects across fetches, so the force layout keeps their positions (x/y live on
//           the objects) and only new nodes fly in.
//   latest  Set of node/edge ids touched by the most recent tool call: these glow.
//   touched Set of every node/edge id the agent has touched in this run.
//   roles   Map account_id -> role, filled once the verdict arrives.
//   hud     {text, live?, verdict?} status line drawn over the canvas (current step / verdict).
import { useEffect, useRef, useState } from 'react';
import ForceGraph2D from 'react-force-graph-2d';

const COLORS = {
  Account: '#4c8dff', Device: '#a274e8', Phone: '#2bb3a3', VPA: '#8d96a8',
  Alert: '#f2a83b', Case: '#48b86b', frozen: '#e5484d',
};
const RADIUS = { Account: 5, Alert: 6, Case: 6, Device: 4, Phone: 4, VPA: 3 };
// Ring members get an outline in their role's color (victims light, mules red), so the
// layering structure reads at a glance once the verdict lands.
const ROLE_COLORS = { victim: '#e4e7ee', layer: '#ff8a8d', collector: '#ff5c7a', cashout: '#ff3b3b' };

const fill = (n) => (n.label === 'Account' && n.props?.status === 'frozen' ? COLORS.frozen : COLORS[n.label] ?? '#999');
// react-force-graph replaces link.source/target with the node objects after the first tick.
const endId = (end) => (typeof end === 'object' ? end.id : end);

export default function GraphCanvas({ graph, latest, touched, roles, hud }) {
  const wrap = useRef(null);
  const fg = useRef(null);
  const [size, setSize] = useState({ width: 0, height: 0 });

  // The canvas needs explicit pixel sizes; track the pane's size.
  useEffect(() => {
    const ro = new ResizeObserver(([e]) => setSize({ width: e.contentRect.width, height: e.contentRect.height }));
    ro.observe(wrap.current);
    return () => ro.disconnect();
  }, []);

  // Re-frame the view when new nodes arrive.
  useEffect(() => {
    if (!graph.nodes.length) return;
    const t = setTimeout(() => fg.current?.zoomToFit(400, 40), 600);
    return () => clearTimeout(t);
  }, [graph.nodes.length]);

  const dimmed = (id) => touched.size > 0 && !touched.has(id);
  // Read the theme's text color once per render, not once per node per frame.
  const labelColor = getComputedStyle(document.body).getPropertyValue('--text').trim() || '#ddd';

  const sent = graph.links.filter((l) => l.type === 'SENT').length;

  return (
    <div className="canvas" ref={wrap}>
      {!graph.nodes.length && (
        <div className="empty">
          <div className="empty-card">
            <h3>Pick an alert to start an investigation</h3>
            <ol>
              <li><b>Investigate.</b> The agent walks the FalkorDB graph with Cypher; every node it touches lights up here.</li>
              <li><b>Approve.</b> It proposes accounts to freeze. Nothing is frozen until a person approves.</li>
              <li><b>Verify.</b> A path query re-checks the graph and proves no money route remains.</li>
            </ol>
          </div>
        </div>
      )}
      {hud && (
        <div className={`hud ${hud.verdict ?? ''}`}>
          {hud.live && <span className="pulse" />}{hud.text}
        </div>
      )}
      {graph.nodes.length > 0 && <div className="counts">{graph.nodes.length} nodes · {sent} transfers in view</div>}
      <ForceGraph2D
        ref={fg}
        maxZoom={2} // a small subgraph would otherwise zoom-to-fit into giant blobs
        width={size.width}
        height={size.height}
        graphData={graph}
        backgroundColor="rgba(0,0,0,0)"
        cooldownTicks={120}
        linkDirectionalArrowLength={(l) => (l.type === 'SENT' ? 4 : 0)}
        linkDirectionalArrowRelPos={1}
        linkColor={(l) => (latest.has(l.id) ? '#ffd166' : dimmed(l.id) ? 'rgba(140,150,170,0.15)' : l.type === 'SENT' ? 'rgba(120,160,255,0.6)' : 'rgba(160,160,180,0.35)')}
        linkWidth={(l) => (latest.has(l.id) ? 2.5 : 1)}
        linkLineDash={(l) => (l.type === 'SENT' ? null : [2, 2])}
        linkDirectionalParticles={(l) => (latest.has(l.id) && l.type === 'SENT' ? 3 : 0)}
        linkLabel={(l) => (l.type === 'SENT' ? `${endId(l.source)} → ${endId(l.target)}: ₹${l.amount}` : l.type)}
        nodeLabel={(n) => `${n.label} ${n.id}${n.props?.status ? ` (${n.props.status})` : ''}`}
        nodeCanvasObject={(n, ctx, scale) => {
          const r = RADIUS[n.label] ?? 4;
          ctx.globalAlpha = dimmed(n.id) ? 0.25 : 1;
          if (latest.has(n.id)) { // glow ring for what the agent just looked at
            ctx.beginPath(); ctx.arc(n.x, n.y, r + 4, 0, 2 * Math.PI);
            ctx.fillStyle = 'rgba(255,209,102,0.35)'; ctx.fill();
          }
          const role = roles.get(n.id);
          ctx.beginPath(); ctx.arc(n.x, n.y, r, 0, 2 * Math.PI);
          ctx.fillStyle = fill(n); ctx.fill();
          if (role) { // role outline, sized in screen pixels so it stays crisp at any zoom
            ctx.lineWidth = 2 / scale; ctx.strokeStyle = ROLE_COLORS[role] ?? labelColor;
            ctx.beginPath(); ctx.arc(n.x, n.y, r + 2 / scale + 1, 0, 2 * Math.PI); ctx.stroke();
          }
          if (role || scale >= 1.9) { // labels only when zoomed in, or for ring members
            const fontSize = 11 / scale;
            ctx.font = `${role ? '600 ' : ''}${fontSize}px system-ui, sans-serif`;
            ctx.textAlign = 'center'; ctx.textBaseline = 'top';
            ctx.fillStyle = role ? ROLE_COLORS[role] ?? labelColor : labelColor;
            ctx.fillText(role ? `${n.id} · ${role}` : n.id, n.x, n.y + r + 3);
          }
          ctx.globalAlpha = 1;
        }}
        nodePointerAreaPaint={(n, color, ctx) => {
          ctx.beginPath(); ctx.arc(n.x, n.y, (RADIUS[n.label] ?? 4) + 2, 0, 2 * Math.PI);
          ctx.fillStyle = color; ctx.fill();
        }}
      />
      {graph.nodes.length > 0 && (
        <div className="legend">
          {Object.entries(COLORS).map(([k, c]) => <span key={k}><i style={{ background: c }} />{k}</span>)}
          {roles.size > 0 && Object.entries(ROLE_COLORS).map(([k, c]) => <span key={k}><i className="ring" style={{ borderColor: c }} />{k}</span>)}
          <span><i className="glow" />agent's latest step</span>
        </div>
      )}
    </div>
  );
}
