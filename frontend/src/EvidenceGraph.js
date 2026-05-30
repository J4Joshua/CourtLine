import React, { useCallback, useEffect, useRef, useState } from 'react';

// ── Colors — soft pastels matching app character style ─────────────────────────

const NODE_COL = {
  brief:                { fill: '#f0f0ff', stroke: '#8888c0', text: '#3a3a70' },
  claim:                { fill: '#fff4e6', stroke: '#c9a84c', text: '#5a3e00' },
  waiting:              { fill: '#f4f4f4', stroke: '#c4bfb8', text: '#9e9890' },
  verdict_match:        { fill: '#f0fff4', stroke: '#66bb6a', text: '#1b5e20' },
  verdict_contradiction:{ fill: '#fff0f0', stroke: '#ef9a9a', text: '#b71c1c' },
  verdict_unverifiable: { fill: '#fffbf0', stroke: '#ffcc80', text: '#7a4800' },
};

const EDGE_COL = {
  pending:       '#c8cde8',
  match:         '#66bb6a',
  contradiction: '#ef9a9a',
  unverifiable:  '#ffcc80',
};

// Base radii for physics collision. Rendered radius may be larger (computeLayout).
const NODE_R = { brief: 52, claim: 44, verdict: 36, waiting: 52 };

function nodeColors(n) {
  if (n.type === 'brief')   return NODE_COL.brief;
  if (n.type === 'claim')   return NODE_COL.claim;
  if (n.type === 'waiting') return NODE_COL.waiting;
  if (n.verdict === 'match')         return NODE_COL.verdict_match;
  if (n.verdict === 'contradiction') return NODE_COL.verdict_contradiction;
  return NODE_COL.verdict_unverifiable;
}

function nodeGradId(n) {
  if (n.type === 'brief')   return 'url(#rg-brief)';
  if (n.type === 'claim')   return 'url(#rg-claim)';
  if (n.type === 'waiting') return 'url(#rg-waiting)';
  if (n.verdict === 'match')         return 'url(#rg-match)';
  if (n.verdict === 'contradiction') return 'url(#rg-contra)';
  return 'url(#rg-unverif)';
}

function baseR(n) { return NODE_R[n.type] ?? NODE_R.claim; }

// ── Text layout — no truncation, wrap at word boundaries, fit in circle ────────
//
// Returns { lines: string[], fontSize: number, r: number }
// fontSize: 10–13px. r may expand beyond base to fit 2 lines.

const CHAR_W_RATIO = 0.58; // avg char width / fontSize for system-ui
const H_PAD = 10;          // horizontal padding each side inside circle

function computeLayout(label, base) {
  const words = label.split(' ');

  // Split into 2 balanced lines at word boundary
  let lines;
  if (words.length === 1) {
    lines = [label];
  } else {
    // Find word split that balances line lengths closest to each other
    let best = 1, bestDiff = Infinity;
    for (let i = 1; i < words.length; i++) {
      const l1 = words.slice(0, i).join(' ').length;
      const l2 = words.slice(i).join(' ').length;
      const diff = Math.abs(l1 - l2);
      if (diff < bestDiff) { bestDiff = diff; best = i; }
    }
    const l1 = words.slice(0, best).join(' ');
    const l2 = words.slice(best).join(' ');
    lines = l2 ? [l1, l2] : [l1];
  }

  const maxChars = Math.max(...lines.map(l => l.length));

  // Try font sizes 13 → 10; pick smallest r that stays within 30% of base
  for (let fs = 13; fs >= 10; fs--) {
    const lineW = maxChars * fs * CHAR_W_RATIO + H_PAD * 2;
    const reqR  = Math.ceil(lineW / 2) + H_PAD;
    if (reqR <= base * 1.3) {
      return { lines, fontSize: fs, r: Math.max(base, reqR) };
    }
  }

  // At fs=10, just use however large the circle needs to be (no truncation)
  const lineW = maxChars * 10 * CHAR_W_RATIO + H_PAD * 2;
  const reqR  = Math.ceil(lineW / 2) + H_PAD;
  return { lines, fontSize: 10, r: reqR };
}

// ── Bezier edge path ───────────────────────────────────────────────────────────

function bezierPath(sx, sy, tx, ty) {
  const dx = tx - sx, dy = ty - sy;
  const len = Math.sqrt(dx * dx + dy * dy) + 0.01;
  const mx = (sx + tx) / 2, my = (sy + ty) / 2;
  const off = Math.min(55, len * 0.2);
  return `M ${sx.toFixed(1)} ${sy.toFixed(1)} Q ${(mx - dy / len * off).toFixed(1)} ${(my + dx / len * off).toFixed(1)} ${tx.toFixed(1)} ${ty.toFixed(1)}`;
}

// ── Force simulation ───────────────────────────────────────────────────────────

const MIN_DIST = 160;

function tickForces(nodes, edges) {
  const REP    = 42000;
  const IDEAL  = 240;
  const SPRING = 0.026;
  const DAMP   = 0.84;

  nodes.forEach(n => { n.fx = 0; n.fy = 0; });

  for (let i = 0; i < nodes.length; i++) {
    for (let j = i + 1; j < nodes.length; j++) {
      const dx = nodes[j].x - nodes[i].x;
      const dy = nodes[j].y - nodes[i].y;
      const d  = Math.sqrt(dx * dx + dy * dy) + 0.01;
      const f  = REP / (d * d);
      nodes[i].fx -= f * dx / d;  nodes[i].fy -= f * dy / d;
      nodes[j].fx += f * dx / d;  nodes[j].fy += f * dy / d;
    }
  }

  edges.forEach(e => {
    const s = nodes.find(n => n.id === e.source);
    const t = nodes.find(n => n.id === e.target);
    if (!s || !t) return;
    const dx = t.x - s.x, dy = t.y - s.y;
    const d  = Math.sqrt(dx * dx + dy * dy) + 0.01;
    const f  = (d - IDEAL) * SPRING;
    s.fx += f * dx / d;  s.fy += f * dy / d;
    t.fx -= f * dx / d;  t.fy -= f * dy / d;
  });

  nodes.forEach(n => {
    if (n.type === 'brief') {
      n.fx += (n.ix - n.x) * 0.018;
      n.fy += (n.iy - n.y) * 0.018;
    } else {
      n.fx += (400 - n.x) * 0.003;
      n.fy += (400 - n.y) * 0.003;
    }
    n.vx = (n.vx + n.fx) * DAMP;
    n.vy = (n.vy + n.fy) * DAMP;
    n.x += n.vx;
    n.y += n.vy;
  });

  // Minimum separation enforcement
  for (let i = 0; i < nodes.length; i++) {
    for (let j = i + 1; j < nodes.length; j++) {
      const dx = nodes[j].x - nodes[i].x;
      const dy = nodes[j].y - nodes[i].y;
      const d  = Math.sqrt(dx * dx + dy * dy);
      if (d < MIN_DIST && d > 0.01) {
        const push = (MIN_DIST - d) / 2;
        const nx = dx / d, ny = dy / d;
        nodes[i].x -= nx * push;  nodes[i].y -= ny * push;
        nodes[j].x += nx * push;  nodes[j].y += ny * push;
      }
    }
  }
}

// ── Build brief nodes — full label, no truncation ─────────────────────────────

function buildBriefNodes(facts) {
  if (!facts || facts.length === 0) {
    return [{ id: 'waiting', type: 'waiting', label: 'Awaiting brief…',
              x: 400, y: 300, vx: 0, vy: 0, ix: 400, iy: 300, createdAt: 0 }];
  }
  const cx = 400, cy = 300, radius = Math.min(200, 85 + facts.length * 24);
  return facts.map((label, i) => {
    const a = -Math.PI / 2 + (2 * Math.PI * i) / facts.length;
    const x = cx + Math.cos(a) * radius;
    const y = cy + Math.sin(a) * radius;
    return { id: `brief-${i}`, type: 'brief', label,
             x, y, vx: 0, vy: 0, ix: x, iy: y, createdAt: 0 };
  });
}

// ── Keyword match ─────────────────────────────────────────────────────────────

function matchBrief(claim, nodes) {
  const cl = claim.toLowerCase();
  const briefNodes = nodes.filter(n => n.type === 'brief');
  if (!briefNodes.length) return null;
  let best = briefNodes[0].id, top = 0;
  for (const n of briefNodes) {
    const words = n.label.toLowerCase().split(/\W+/).filter(w => w.length > 3);
    const score = words.filter(w => cl.includes(w)).length;
    if (score > top) { top = score; best = n.id; }
  }
  return best;
}

function focusVb(nodes) {
  if (!nodes.length) return { x: -60, y: -60, w: 920, h: 720 };
  const pad = 220;
  const xs = nodes.map(n => n.x), ys = nodes.map(n => n.y);
  return {
    x: Math.min(...xs) - pad, y: Math.min(...ys) - pad,
    w: Math.max(Math.max(...xs) - Math.min(...xs) + pad * 2, 400),
    h: Math.max(Math.max(...ys) - Math.min(...ys) + pad * 2, 320),
  };
}

// ── Popup helpers ─────────────────────────────────────────────────────────────

function popupColorClass(n) {
  if (n.type === 'brief')   return 'brief';
  if (n.type === 'claim')   return 'claim';
  if (n.type === 'verdict') return n.verdict || 'unverifiable';
  return 'brief';
}

function popupTypeName(n) {
  if (n.type === 'brief') return 'Brief Fact';
  if (n.type === 'claim') return 'Witness Claim';
  if (n.type === 'verdict') {
    if (n.verdict === 'match')         return 'Match';
    if (n.verdict === 'contradiction') return 'Contradiction';
    return 'Unverified';
  }
  return '';
}

function findVerdictDecision(claimLabel, decisions) {
  return decisions.find(d =>
    d.tool_fired === 'fact_check' &&
    d.claim === claimLabel &&
    d.verdict &&
    !d.utterance.startsWith('Fact-checking:')
  ) || decisions.find(d =>
    d.tool_fired === 'fact_check' &&
    d.claim === claimLabel &&
    d.verdict
  );
}

// ── Component ──────────────────────────────────────────────────────────────────

export default function EvidenceGraph({ decisions, briefFacts }) {
  const simRef = useRef(null);

  if (!simRef.current) {
    simRef.current = {
      nodes: buildBriefNodes(null),
      edges: [],
      processedClaims: new Set(),
      claimIds:        new Map(),
      verdictClaims:   new Set(),
      briefReady: false,
      vb:  { x: -60, y: -60, w: 920, h: 720 },
      tvb: { x: -60, y: -60, w: 920, h: 720 },
      userNav: false, navTimer: null,
    };
  }

  const [render, setRender] = useState({
    nodes: simRef.current.nodes, edges: simRef.current.edges,
    viewBox: '-60 -60 920 720',
  });
  const [popup, setPopup] = useState(null);

  const decisionsRef = useRef(decisions);
  useEffect(() => { decisionsRef.current = decisions; }, [decisions]);

  const svgRef      = useRef(null);
  const dragRef     = useRef(null);
  const rafRef      = useRef(null);
  const lastT       = useRef(0);
  const lastProcRef = useRef(0);

  // ── Simulation loop ──────────────────────────────────────────────────────────

  useEffect(() => {
    let alive = true;
    const frame = (t) => {
      if (!alive) return;
      const sim = simRef.current;
      tickForces(sim.nodes, sim.edges);
      const LF = 0.05;
      sim.vb.x += (sim.tvb.x - sim.vb.x) * LF;
      sim.vb.y += (sim.tvb.y - sim.vb.y) * LF;
      sim.vb.w += (sim.tvb.w - sim.vb.w) * LF;
      sim.vb.h += (sim.tvb.h - sim.vb.h) * LF;
      if (t - lastT.current > 30) {
        lastT.current = t;
        const { x, y, w, h } = sim.vb;
        setRender({
          nodes: [...sim.nodes], edges: [...sim.edges],
          viewBox: `${x.toFixed(1)} ${y.toFixed(1)} ${w.toFixed(1)} ${h.toFixed(1)}`,
        });
      }
      rafRef.current = requestAnimationFrame(frame);
    };
    rafRef.current = requestAnimationFrame(frame);
    return () => { alive = false; cancelAnimationFrame(rafRef.current); };
  }, []);

  // ── Init brief nodes ─────────────────────────────────────────────────────────

  useEffect(() => {
    if (briefFacts === null) return;
    const sim = simRef.current;
    if (sim.briefReady) return;
    sim.briefReady = true;
    sim.nodes = buildBriefNodes(briefFacts);
    for (let t = 0; t < 300; t++) tickForces(sim.nodes, sim.edges);
    sim.tvb = focusVb(sim.nodes);
  }, [briefFacts]);

  // ── Process decisions ────────────────────────────────────────────────────────

  useEffect(() => {
    const sim = simRef.current;
    if (!sim.briefReady) return;
    const now = Date.now();
    for (let i = lastProcRef.current; i < decisions.length; i++) {
      const d = decisions[i];
      if (d.tool_fired !== 'fact_check' || !d.claim) continue;
      const claim = d.claim;

      if (!sim.processedClaims.has(claim)) {
        sim.processedClaims.add(claim);
        const briefId = matchBrief(claim, sim.nodes);
        const brief   = sim.nodes.find(n => n.id === briefId);
        const angle = Math.random() * Math.PI * 2;
        const dist  = 205 + Math.random() * 60;
        const cid   = `claim-${i}`;
        const cn = {
          id: cid, type: 'claim',
          label: claim,            // full label — no truncation
          x: (brief?.x ?? 400) + Math.cos(angle) * dist,
          y: (brief?.y ?? 300) + Math.sin(angle) * dist,
          vx: (Math.random() - 0.5) * 6, vy: (Math.random() - 0.5) * 6,
          ix: 0, iy: 0, createdAt: now,
        };
        sim.nodes.push(cn);
        // Springy nudge — nearby nodes gently bounce away
        sim.nodes.forEach(other => {
          if (other.id === cn.id) return;
          const dx = other.x - cn.x, dy = other.y - cn.y;
          const d  = Math.sqrt(dx * dx + dy * dy) + 0.01;
          if (d < 290) { const k = ((290 - d) / 290) * 5; other.vx += (dx / d) * k; other.vy += (dy / d) * k; }
        });
        sim.claimIds.set(claim, cid);
        if (briefId) sim.edges.push({ id: `e-${cid}-${briefId}`, source: cid, target: briefId, verdict: 'pending', createdAt: now });
        if (!sim.userNav) sim.tvb = focusVb([cn, brief].filter(Boolean));
      }

      if (d.verdict && !sim.verdictClaims.has(claim)) {
        sim.verdictClaims.add(claim);
        const cid = sim.claimIds.get(claim);
        const cn  = sim.nodes.find(n => n.id === cid);
        const vtype  = d.verdict === 'TRUE' ? 'match' : d.verdict === 'FALSE' ? 'contradiction' : 'unverifiable';
        const vLabel = d.verdict === 'TRUE' ? 'MATCH' : d.verdict === 'FALSE' ? 'CONTRA' : 'UNCLEAR';
        const va = Math.random() * Math.PI * 2;
        const vid = `verdict-${i}`;
        const vn = {
          id: vid, type: 'verdict', verdict: vtype, label: vLabel,
          x: (cn?.x ?? 400) + Math.cos(va) * 148,
          y: (cn?.y ?? 300) + Math.sin(va) * 148,
          vx: (Math.random() - 0.5) * 4, vy: (Math.random() - 0.5) * 4,
          ix: 0, iy: 0, createdAt: now,
        };
        sim.nodes.push(vn);
        // Springy nudge for verdict arrival
        sim.nodes.forEach(other => {
          if (other.id === vn.id) return;
          const dx = other.x - vn.x, dy = other.y - vn.y;
          const d  = Math.sqrt(dx * dx + dy * dy) + 0.01;
          if (d < 220) { const k = ((220 - d) / 220) * 3.5; other.vx += (dx / d) * k; other.vy += (dy / d) * k; }
        });
        const briefId = matchBrief(claim, sim.nodes);
        const ce = sim.edges.find(e => e.source === cid && e.target === briefId);
        if (ce) ce.verdict = vtype;
        sim.edges.push({ id: `e-${vid}`, source: cid, target: vid, verdict: vtype, createdAt: now });
        if (!sim.userNav) sim.tvb = focusVb([cn, vn].filter(Boolean));
      }
    }
    lastProcRef.current = decisions.length;
  }, [decisions.length, briefFacts]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Pan / zoom ───────────────────────────────────────────────────────────────

  const onMouseDown = useCallback((e) => {
    if (e.button !== 0) return;
    const sim = simRef.current;
    dragRef.current = { sx: e.clientX, sy: e.clientY, svb: { ...sim.vb } };
    sim.userNav = true; clearTimeout(sim.navTimer);
  }, []);

  const onMouseMove = useCallback((e) => {
    if (!dragRef.current || !svgRef.current) return;
    const sim = simRef.current;
    const rect = svgRef.current.getBoundingClientRect();
    const dx = (e.clientX - dragRef.current.sx) * (sim.vb.w / rect.width);
    const dy = (e.clientY - dragRef.current.sy) * (sim.vb.h / rect.height);
    const svb = dragRef.current.svb;
    sim.tvb = { x: svb.x - dx, y: svb.y - dy, w: svb.w, h: svb.h };
    sim.vb  = { ...sim.tvb };
  }, []);

  const onMouseUp = useCallback(() => {
    dragRef.current = null;
    const sim = simRef.current;
    sim.navTimer = setTimeout(() => { sim.userNav = false; }, 6000);
  }, []);

  const onWheel = useCallback((e) => {
    e.preventDefault();
    const sim = simRef.current;
    const factor = e.deltaY > 0 ? 1.13 : 0.87;
    if (!svgRef.current) return;
    const rect = svgRef.current.getBoundingClientRect();
    const mx = sim.vb.x + (e.clientX - rect.left) / rect.width  * sim.vb.w;
    const my = sim.vb.y + (e.clientY - rect.top)  / rect.height * sim.vb.h;
    const nw = Math.max(200, Math.min(2400, sim.vb.w * factor));
    const nh = Math.max(150, Math.min(1800, sim.vb.h * factor));
    sim.tvb = { x: mx - (mx - sim.vb.x) / sim.vb.w * nw, y: my - (my - sim.vb.y) / sim.vb.h * nh, w: nw, h: nh };
    sim.vb  = { ...sim.tvb };
    sim.userNav = true; clearTimeout(sim.navTimer);
    sim.navTimer = setTimeout(() => { sim.userNav = false; }, 4000);
  }, []);

  const onNodeClick = useCallback((e, n) => {
    e.stopPropagation();
    setPopup(n);
  }, []);

  // ── Render ───────────────────────────────────────────────────────────────────

  const now = Date.now();

  // Build popup content
  let popupContent = null;
  if (popup) {
    const cc = popupColorClass(popup);
    let detail = null;

    if (popup.type === 'claim') {
      const d = findVerdictDecision(popup.label, decisionsRef.current);
      if (d) {
        detail = (
          <div className="npp-detail">
            <span className={`npp-verdict-badge nppvb-${d.verdict.toLowerCase()}`}>{d.verdict}</span>
            <p className="npp-text">{d.utterance}</p>
          </div>
        );
      }
    }

    if (popup.type === 'verdict') {
      const parentEdge = simRef.current.edges.find(e => e.target === popup.id);
      const parentNode = parentEdge ? simRef.current.nodes.find(n => n.id === parentEdge.source) : null;
      const d = parentNode ? findVerdictDecision(parentNode.label, decisionsRef.current) : null;
      detail = (
        <div className="npp-detail">
          {parentNode && <p className="npp-claim-ref">"{parentNode.label}"</p>}
          {d && <p className="npp-text">{d.utterance}</p>}
        </div>
      );
    }

    popupContent = (
      <div className="node-popup-overlay" onClick={() => setPopup(null)}>
        <div className={`node-popup npp-${cc}`} onClick={e => e.stopPropagation()}>
          <button className="npp-close" onClick={() => setPopup(null)}>×</button>
          <div className={`npp-badge nppb-${cc}`}>{popupTypeName(popup)}</div>
          <div className="npp-title">{popup.label}</div>
          {detail}
        </div>
      </div>
    );
  }

  return (
    <div className="graph-container">

      {/* Legend */}
      <div className="graph-legend">
        {[
          { cls: 'ld-brief',  label: 'Brief fact' },
          { cls: 'ld-claim',  label: 'Witness claim' },
          { cls: 'ld-match',  label: 'Match' },
          { cls: 'ld-contra', label: 'Contradiction' },
        ].map(({ cls, label }) => (
          <div key={cls} className="legend-row">
            <span className={`legend-dot ${cls}`} />
            <span className="legend-label">{label}</span>
          </div>
        ))}
      </div>

      {briefFacts === null && (
        <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', pointerEvents: 'none' }}>
          <span style={{ fontSize: 13, color: '#c4bfb8', fontStyle: 'italic' }}>Loading case brief…</span>
        </div>
      )}

      <style>{`
        @keyframes eg-pop {
          0%   { transform: scale(0.5); opacity: 0.6; }
          65%  { transform: scale(1.12); }
          100% { transform: scale(1.0); opacity: 1; }
        }
        @keyframes eg-draw {
          from { stroke-dashoffset: 700; }
          to   { stroke-dashoffset: 0; }
        }
        @keyframes eg-flow {
          to { stroke-dashoffset: -24; }
        }
        .eg-pop {
          animation: eg-pop 420ms cubic-bezier(0.34, 1.56, 0.64, 1) forwards;
          transform-box: fill-box;
          transform-origin: center;
        }
        .eg-draw { animation: eg-draw 1s ease-out forwards; }
        .eg-flow { animation: eg-flow 1.4s linear infinite; }
      `}</style>

      <svg
        ref={svgRef}
        viewBox={render.viewBox}
        className="evidence-svg"
        onMouseDown={onMouseDown}
        onMouseMove={onMouseMove}
        onMouseUp={onMouseUp}
        onMouseLeave={onMouseUp}
        onWheel={onWheel}
        onClick={() => setPopup(null)}
      >
        <defs>
          {/* Radial gradients — lighter top-left, deeper bottom-right */}
          <radialGradient id="rg-brief" cx="35%" cy="30%" r="70%">
            <stop offset="0%" stopColor="#fafaff" />
            <stop offset="100%" stopColor="#d8d8f2" />
          </radialGradient>
          <radialGradient id="rg-claim" cx="35%" cy="30%" r="70%">
            <stop offset="0%" stopColor="#fffcf5" />
            <stop offset="100%" stopColor="#e8d4a8" />
          </radialGradient>
          <radialGradient id="rg-waiting" cx="35%" cy="30%" r="70%">
            <stop offset="0%" stopColor="#fafafa" />
            <stop offset="100%" stopColor="#dcdcdc" />
          </radialGradient>
          <radialGradient id="rg-match" cx="35%" cy="30%" r="70%">
            <stop offset="0%" stopColor="#f4fff8" />
            <stop offset="100%" stopColor="#c0e8cc" />
          </radialGradient>
          <radialGradient id="rg-contra" cx="35%" cy="30%" r="70%">
            <stop offset="0%" stopColor="#fff8f8" />
            <stop offset="100%" stopColor="#e8c4c4" />
          </radialGradient>
          <radialGradient id="rg-unverif" cx="35%" cy="30%" r="70%">
            <stop offset="0%" stopColor="#fffef8" />
            <stop offset="100%" stopColor="#e8d8b4" />
          </radialGradient>
          {/* Paper grain — subtle fractal noise over background */}
          <filter id="paper-grain" x="0%" y="0%" width="100%" height="100%">
            <feTurbulence type="fractalNoise" baseFrequency="0.65" numOctaves="3" stitchTiles="stitch" result="noise" />
            <feColorMatrix in="noise" type="saturate" values="0" />
          </filter>
          {/* Drop shadows */}
          <filter id="shadow-brief" x="-35%" y="-35%" width="170%" height="170%">
            <feDropShadow dx="0" dy="0" stdDeviation="7" floodColor="#8888c0" floodOpacity="0.38" />
          </filter>
          <filter id="shadow-claim" x="-35%" y="-35%" width="170%" height="170%">
            <feDropShadow dx="0" dy="0" stdDeviation="7" floodColor="#c9a84c" floodOpacity="0.38" />
          </filter>
          <filter id="shadow-waiting" x="-35%" y="-35%" width="170%" height="170%">
            <feDropShadow dx="0" dy="0" stdDeviation="6" floodColor="#c4bfb8" floodOpacity="0.38" />
          </filter>
          <filter id="shadow-unverifiable" x="-35%" y="-35%" width="170%" height="170%">
            <feDropShadow dx="0" dy="0" stdDeviation="6" floodColor="#ffcc80" floodOpacity="0.42" />
          </filter>
          <filter id="glow-match" x="-40%" y="-40%" width="180%" height="180%">
            <feGaussianBlur in="SourceGraphic" stdDeviation="5" result="b" />
            <feColorMatrix in="b" type="matrix" values="0 0 0 0 0.2  0 0 0 0 0.73  0 0 0 0 0.24  0 0 0 0.45 0" result="g" />
            <feMerge><feMergeNode in="g" /><feMergeNode in="SourceGraphic" /></feMerge>
          </filter>
          <filter id="glow-contra" x="-40%" y="-40%" width="180%" height="180%">
            <feGaussianBlur in="SourceGraphic" stdDeviation="5" result="b" />
            <feColorMatrix in="b" type="matrix" values="0 0 0 0 0.94  0 0 0 0 0.6  0 0 0 0 0.6  0 0 0 0.45 0" result="g" />
            <feMerge><feMergeNode in="g" /><feMergeNode in="SourceGraphic" /></feMerge>
          </filter>
        </defs>

        {/* Paper texture — very faint grain over the whole canvas */}
        <rect x="-5000" y="-5000" width="10000" height="10000"
          fill="none" filter="url(#paper-grain)" opacity="0.045"
          style={{ pointerEvents: 'none' }}
        />

        {/* Edges */}
        {render.edges.map(e => {
          const s = render.nodes.find(n => n.id === e.source);
          const t = render.nodes.find(n => n.id === e.target);
          if (!s || !t) return null;
          const isNew  = (now - (e.createdAt || 0)) < 950;
          const isPend = e.verdict === 'pending';
          let dashArray, edgeCls;
          if (isNew)        { dashArray = '700 700'; edgeCls = 'eg-draw'; }
          else if (isPend)  { dashArray = '8 8';     edgeCls = 'eg-flow'; }
          else              { dashArray = undefined;  edgeCls = ''; }
          return (
            <path
              key={e.id}
              d={bezierPath(s.x, s.y, t.x, t.y)}
              stroke={EDGE_COL[e.verdict] || EDGE_COL.pending}
              strokeWidth={2.5}
              strokeLinecap="round"
              fill="none"
              opacity={isPend ? 0.55 : 0.9}
              strokeDasharray={dashArray}
              className={edgeCls}
            />
          );
        })}

        {/* Nodes */}
        {render.nodes.map(n => {
          const { lines, fontSize, r } = computeLayout(n.label, baseR(n));
          const col    = nodeColors(n);
          const isNew  = (now - (n.createdAt || 0)) < 620;
          const filter = n.type === 'verdict'
            ? (n.verdict === 'match' ? 'url(#glow-match)' : n.verdict === 'contradiction' ? 'url(#glow-contra)' : 'url(#shadow-unverifiable)')
            : n.type === 'brief' ? 'url(#shadow-brief)'
            : n.type === 'waiting' ? 'url(#shadow-waiting)'
            : 'url(#shadow-claim)';
          const lineH  = fontSize * 1.25;
          const fw     = n.type === 'brief' ? '600' : n.type === 'verdict' ? '700' : '500';
          const hlR    = r * 0.18;

          return (
            <g
              key={n.id}
              transform={`translate(${n.x.toFixed(1)},${n.y.toFixed(1)})`}
              onClick={(e) => onNodeClick(e, n)}
              style={{ cursor: 'pointer' }}
            >
              {/* Inner g carries the pop-in scale animation */}
              <g className={isNew ? 'eg-pop' : ''}>
                <circle r={r} fill={nodeGradId(n)} filter={filter} />
                {/* White highlight dot — top-left, cartoon light reflection */}
                <circle
                  cx={-r * 0.3} cy={-r * 0.35} r={hlR}
                  fill="white" opacity={0.4}
                  style={{ pointerEvents: 'none' }}
                />
                {lines.length === 1 ? (
                  <text
                    y="0"
                    dominantBaseline="middle"
                    textAnchor="middle"
                    fill={col.text}
                    fontSize={fontSize}
                    fontWeight={fw}
                    fontFamily="-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif"
                    style={{ pointerEvents: 'none', userSelect: 'none' }}
                  >
                    {lines[0]}
                  </text>
                ) : (
                  <text
                    textAnchor="middle"
                    fill={col.text}
                    fontSize={fontSize}
                    fontWeight={fw}
                    fontFamily="-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif"
                    style={{ pointerEvents: 'none', userSelect: 'none' }}
                  >
                    <tspan x="0" y={-(lineH / 2)}>{lines[0]}</tspan>
                    <tspan x="0" dy={lineH}>{lines[1]}</tspan>
                  </text>
                )}
              </g>
            </g>
          );
        })}
      </svg>

      {/* Node click popup — position:absolute inside graph-container, no fixed */}
      {popupContent}
    </div>
  );
}
