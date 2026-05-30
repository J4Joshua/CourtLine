import React, { useCallback, useEffect, useRef, useState } from 'react';
import './App.css';
import lawyerImg from './lawyer.png';

const API = 'http://localhost:7860';
const WS_TRANSCRIPT = 'ws://localhost:7860/ws/transcript';
const WS_DECISIONS  = 'ws://localhost:7860/ws/decisions';

// ── Utilities ─────────────────────────────────────────────────────────────────

function formatTs(iso) {
  if (!iso) return '';
  return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}
function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1048576).toFixed(1)} MB`;
}
function fileLabel(name) {
  const ext = name.split('.').pop().toLowerCase();
  if (ext === 'pdf') return 'PDF';
  if (['jpg','jpeg','png','gif','webp'].includes(ext)) return 'IMG';
  if (ext === 'docx' || ext === 'doc') return 'DOC';
  if (ext === 'txt') return 'TXT';
  return 'FILE';
}

// ── Icons (inline SVG) ────────────────────────────────────────────────────────

function IconCheck({ color = '#868e96' }) {
  return (
    <svg width="13" height="13" viewBox="0 0 13 13" fill="none">
      <path d="M2 6.5l3.2 3.2L11 3" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
    </svg>
  );
}
function IconBook() {
  return (
    <svg width="13" height="13" viewBox="0 0 13 13" fill="none">
      <rect x="1.5" y="1" width="10" height="11" rx="1.5" stroke="#7048e8" strokeWidth="1.4"/>
      <path d="M3.5 4.5h6M3.5 7h6M3.5 9.5h4" stroke="#7048e8" strokeWidth="1.2" strokeLinecap="round"/>
    </svg>
  );
}
function IconSearch() {
  return (
    <svg width="13" height="13" viewBox="0 0 13 13" fill="none">
      <circle cx="5.5" cy="5.5" r="3.5" stroke="#0c7a5a" strokeWidth="1.4"/>
      <path d="M8.5 8.5l2.8 2.8" stroke="#0c7a5a" strokeWidth="1.4" strokeLinecap="round"/>
    </svg>
  );
}
function IconBubble() {
  return (
    <svg width="13" height="13" viewBox="0 0 13 13" fill="none">
      <path d="M1.5 1.5h10a.5.5 0 01.5.5v6a.5.5 0 01-.5.5H7.5l-2 2-2-2H1.5a.5.5 0 01-.5-.5V2a.5.5 0 01.5-.5z" stroke="#1a1a2e" strokeWidth="1.4"/>
    </svg>
  );
}
function IconEye() {
  return (
    <svg width="13" height="13" viewBox="0 0 13 13" fill="none">
      <path d="M1 6.5C2.5 3.5 5 2 6.5 2S10.5 3.5 12 6.5C10.5 9.5 8 11 6.5 11S2.5 9.5 1 6.5z" stroke="#b07d00" strokeWidth="1.4"/>
      <circle cx="6.5" cy="6.5" r="1.5" stroke="#b07d00" strokeWidth="1.4"/>
    </svg>
  );
}
function IconCamera() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
      <rect x="1" y="3.5" width="12" height="8" rx="1.5" stroke="currentColor" strokeWidth="1.4"/>
      <circle cx="7" cy="7.5" r="2" stroke="currentColor" strokeWidth="1.4"/>
      <path d="M4.5 3.5l.8-1.5h3.4l.8 1.5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"/>
    </svg>
  );
}

// Derive accent class for decision cards
function decisionAccent(tool, utterance) {
  if (tool === 'fact_check') {
    if (/false|impossible|closed|closes|doesn't|doesn't|not open|wrong|mismatch/i.test(utterance)) return 'accent-red';
    if (/true|correct|confirmed|accurate/i.test(utterance)) return 'accent-green';
    return 'accent-gray';
  }
  if (tool === 'recall') return 'accent-purple';
  if (tool === 'search') return 'accent-teal';
  if (tool === 'camera') return 'accent-amber';
  return 'accent-navy';
}
function DecisionIcon({ tool, utterance }) {
  if (tool === 'fact_check') {
    const isFalse = /false|impossible|closed|closes|doesn't|doesn't|not open|wrong|mismatch/i.test(utterance);
    const isTrue  = /true|correct|confirmed|accurate/i.test(utterance);
    return <IconCheck color={isFalse ? '#c92a2a' : isTrue ? '#2b8a3e' : '#adb5bd'} />;
  }
  if (tool === 'recall')  return <IconBook />;
  if (tool === 'search')  return <IconSearch />;
  if (tool === 'camera')  return <IconEye />;
  return <IconBubble />;
}

// ── WebSocket hook ────────────────────────────────────────────────────────────

function useWebSocket(url, onMessage, onOpen) {
  const wsRef = useRef(null);
  const reconnectRef = useRef(null);
  useEffect(() => {
    let cancelled = false;
    function connect() {
      if (cancelled) return;
      const ws = new WebSocket(url);
      wsRef.current = ws;
      ws.onopen = () => { if (onOpen) onOpen(); };
      ws.onmessage = (e) => { try { onMessage(JSON.parse(e.data)); } catch (_) {} };
      const ping = setInterval(() => { if (ws.readyState === WebSocket.OPEN) ws.send('ping'); }, 20000);
      ws.onerror = () => clearInterval(ping);
      ws.onclose = () => { clearInterval(ping); if (!cancelled) reconnectRef.current = setTimeout(connect, 2000); };
    }
    connect();
    return () => {
      cancelled = true;
      clearTimeout(reconnectRef.current);
      if (wsRef.current) wsRef.current.close();
    };
  }, [url]); // eslint-disable-line react-hooks/exhaustive-deps
  return wsRef;
}

// ── Sidebar character ─────────────────────────────────────────────────────────

function SidebarCharacter({ latestDecision }) {
  const [bouncing, setBouncing] = useState(false);
  const [bubble, setBubble] = useState('');
  const prevRef = useRef(null);

  useEffect(() => {
    if (!latestDecision) return;
    const key = latestDecision.timestamp;
    if (key === prevRef.current) return;
    prevRef.current = key;

    setBouncing(true);
    // Show the verdict text in the bubble (trim to ~120 chars)
    const text = latestDecision.utterance.replace(/^\(.*?\)\s*/, '');
    if (text) setBubble(text.length > 120 ? text.slice(0, 117) + '…' : text);

    setTimeout(() => setBouncing(false), 500);
    setTimeout(() => setBubble(''), 4000);
  }, [latestDecision]);

  return (
    <div className="character-wrap">
      {bubble && <div className="character-bubble">{bubble}</div>}
      <img
        src={lawyerImg}
        alt="Sidebar"
        className={`character-img${bouncing ? ' character-bounce' : ''}`}
      />
    </div>
  );
}

// ── Step 1: Open Case ─────────────────────────────────────────────────────────

function OpenCasePage({ onNext }) {
  const [form, setForm] = useState({ caseName: '', defendantName: '', charges: '', jurisdiction: '' });
  const set = (key) => (e) => setForm((p) => ({ ...p, [key]: e.target.value }));

  return (
    <div className="step-page">
      <div className="step-logo">Sidebar</div>
      <div className="step-card">
        <div className="step-counter">1 / 3</div>
        <h2 className="step-title">Open Case</h2>
        <p className="step-sub">Enter case details to initialize Sidebar.</p>
        <div className="form-grid">
          <div className="form-field col-span-2">
            <label>Case Name *</label>
            <input placeholder="State v. Johnson" value={form.caseName} onChange={set('caseName')} />
          </div>
          <div className="form-field">
            <label>Defendant Name</label>
            <input placeholder="Full legal name" value={form.defendantName} onChange={set('defendantName')} />
          </div>
          <div className="form-field">
            <label>Jurisdiction</label>
            <input placeholder="California Superior Court" value={form.jurisdiction} onChange={set('jurisdiction')} />
          </div>
          <div className="form-field col-span-2">
            <label>Charges / Allegations</label>
            <input placeholder="e.g. First-degree murder, conspiracy to commit fraud" value={form.charges} onChange={set('charges')} />
          </div>
        </div>
        <button className="btn-primary" disabled={!form.caseName.trim()} onClick={() => form.caseName.trim() && onNext(form)}>
          Open Case →
        </button>
      </div>
    </div>
  );
}

// ── Step 2: Upload Briefs ─────────────────────────────────────────────────────

function UploadBriefsPage({ caseInfo, onNext }) {
  const [files, setFiles] = useState([]);
  const [notes, setNotes] = useState('');
  const [dragging, setDragging] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const inputRef = useRef(null);

  const addFiles = useCallback((incoming) => {
    incoming.forEach((file) => {
      const reader = new FileReader();
      reader.onload = (ev) => {
        setFiles((prev) => {
          if (prev.some((f) => f.name === file.name && f.size === file.size)) return prev;
          return [...prev, { id: `${file.name}-${file.size}`, name: file.name, type: file.type, size: file.size, b64: ev.target.result.split(',')[1] }];
        });
      };
      reader.readAsDataURL(file);
    });
  }, []);

  const handleDrop = useCallback((e) => { e.preventDefault(); setDragging(false); addFiles(Array.from(e.dataTransfer.files)); }, [addFiles]);

  const handleBrief = async () => {
    setSaving(true);
    try {
      await fetch(`${API}/brief`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ case_info: caseInfo, notes, files: files.map((f) => ({ name: f.name, type: f.type, b64: f.b64 })) }),
      });
      setSaved(true);
      setTimeout(onNext, 1500);
    } catch {
      alert('Cannot reach backend on port 7860.');
      setSaving(false);
    }
  };

  return (
    <div className="step-page">
      <div className="step-logo">Sidebar</div>
      <div className="step-card step-card-wide">
        <div className="step-counter">2 / 3</div>
        <h2 className="step-title">Upload Briefs</h2>
        <p className="step-sub">
          Briefing Sidebar for <strong>{caseInfo.caseName}</strong>. Upload documents and add notes —
          Sidebar will cross-reference these against live testimony.
        </p>
        <div
          className={`dropzone${dragging ? ' drag-over' : ''}`}
          onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
          onDragLeave={() => setDragging(false)}
          onDrop={handleDrop}
          onClick={() => inputRef.current?.click()}
        >
          <div className="dropzone-arrow">↑</div>
          <div className="dropzone-label">Drop files here or click to browse</div>
          <div className="dropzone-hint">PDF · TXT · DOCX · JPG · PNG</div>
          <input ref={inputRef} type="file" multiple accept=".pdf,.txt,.docx,.jpg,.jpeg,.png" style={{ display: 'none' }} onChange={(e) => addFiles(Array.from(e.target.files))} />
        </div>
        {files.length > 0 && (
          <ul className="file-list">
            {files.map((f) => (
              <li key={f.id} className="file-item">
                <span className={`file-badge fbadge-${fileLabel(f.name).toLowerCase()}`}>{fileLabel(f.name)}</span>
                <span className="file-name">{f.name}</span>
                <span className="file-size">{formatSize(f.size)}</span>
                <button className="file-remove" onClick={() => setFiles((p) => p.filter((x) => x.id !== f.id))}>×</button>
              </li>
            ))}
          </ul>
        )}
        <div className="form-field" style={{ marginTop: 20 }}>
          <label>Additional Notes / Facts</label>
          <textarea className="notes-area" placeholder="Key facts, witness names, timeline, important context…" rows={4} value={notes} onChange={(e) => setNotes(e.target.value)} />
        </div>
        <div className="brief-footer">
          {saved
            ? <div className="brief-confirmed">Sidebar briefed ✓</div>
            : <button className="btn-primary" onClick={handleBrief} disabled={saving}>{saving ? 'Briefing…' : 'Brief Sidebar →'}</button>}
        </div>
      </div>
    </div>
  );
}

// ── Camera panel ──────────────────────────────────────────────────────────────

function CameraPanel({ visionResult, onCapture, capturing }) {
  const videoRef = useRef(null);
  const canvasRef = useRef(null);
  const [streaming, setStreaming] = useState(false);

  const enableCamera = useCallback(() => {
    navigator.mediaDevices.getUserMedia({ video: true, audio: false })
      .then((stream) => { if (videoRef.current) { videoRef.current.srcObject = stream; setStreaming(true); } })
      .catch((err) => console.error('Camera:', err));
  }, []);

  const handleCapture = useCallback(() => {
    if (!videoRef.current || !canvasRef.current) return;
    const canvas = canvasRef.current;
    canvas.width  = videoRef.current.videoWidth  || 640;
    canvas.height = videoRef.current.videoHeight || 480;
    canvas.getContext('2d').drawImage(videoRef.current, 0, 0);
    onCapture(canvas.toDataURL('image/jpeg', 0.8).split(',')[1]);
  }, [onCapture]);

  return (
    <>
      <div className="panel-header">Live Feed</div>
      <div className="camera-panel">
        <div className="webcam-wrapper">
          <video ref={videoRef} autoPlay playsInline muted />
          {!streaming && <button className="btn-enable-camera" onClick={enableCamera}>Enable Camera</button>}
        </div>
        <canvas ref={canvasRef} style={{ display: 'none' }} />
        <button className="btn-capture" onClick={handleCapture} disabled={!streaming || capturing}>
          <IconCamera />
          {capturing ? 'Analyzing…' : 'Capture & Analyze'}
        </button>
        <div className="vision-card">
          <div className="vision-card-label">Demeanor</div>
          {visionResult
            ? <div className="vision-card-text">{visionResult}</div>
            : <div className="vision-card-empty">No capture yet</div>}
        </div>
      </div>
    </>
  );
}

// ── Transcript panel ──────────────────────────────────────────────────────────

function TranscriptPanel({ entries }) {
  const endRef = useRef(null);
  useEffect(() => { endRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [entries]);

  return (
    <>
      <div className="panel-header">Live Transcript</div>
      <div className="transcript-scroll">
        {entries.length === 0 && <div className="panel-empty">Transcript will appear when the session starts.</div>}
        {entries.map((e, i) => {
          if (e.type === 'vision') {
            return (
              <div key={i} className="transcript-demeanor">
                <div className="demeanor-header"><IconEye /><span>DEMEANOR</span></div>
                <div className="demeanor-text">{e.text}</div>
              </div>
            );
          }
          const isAgent = e.role !== 'user';
          return (
            <div key={i} className={`bubble-row ${isAgent ? 'bubble-row-agent' : 'bubble-row-speaker'}`}>
              <div className="bubble-label">{isAgent ? 'SIDEBAR' : 'WITNESS'}</div>
              <div className={`bubble ${isAgent ? 'bubble-agent' : 'bubble-speaker'}`}>
                <div className="bubble-text">{e.text}</div>
                <span className="bubble-ts">{formatTs(e.ts)}</span>
              </div>
            </div>
          );
        })}
        <div ref={endRef} />
      </div>
    </>
  );
}

// ── Decisions panel ───────────────────────────────────────────────────────────

function DecisionsPanel({ decisions }) {
  const endRef = useRef(null);
  useEffect(() => { endRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [decisions]);

  return (
    <>
      <div className="panel-header">Sidebar Intel</div>
      <div className="decisions-scroll">
        {decisions.length === 0 && <div className="panel-empty">Sidebar interventions will appear here.</div>}
        {decisions.map((d, i) => (
          <div key={i} className={`decision-card ${decisionAccent(d.tool_fired, d.utterance)}`}>
            <div className="decision-header">
              <DecisionIcon tool={d.tool_fired} utterance={d.utterance} />
              <span className="decision-tool-label">{d.tool_fired || 'direct'}</span>
              <span className="decision-ts">{formatTs(d.timestamp)}</span>
            </div>
            <div className="decision-utterance">{d.utterance}</div>
          </div>
        ))}
        <div ref={endRef} />
      </div>
    </>
  );
}

// ── Session page ──────────────────────────────────────────────────────────────

function SessionPage({ caseInfo }) {
  const [transcript, setTranscript] = useState([]);
  const [decisions,  setDecisions]  = useState([]);
  const [visionResult, setVisionResult] = useState('');
  const [capturing,  setCapturing]  = useState(false);
  const [connected,  setConnected]  = useState(false);

  const onConnected = useCallback(() => setConnected(true), []);

  useWebSocket(WS_TRANSCRIPT, useCallback((msg) => {
    if (msg.type === 'transcript' || msg.type === 'vision') {
      setTranscript((p) => [...p, msg]);
      if (msg.type === 'vision') setVisionResult(msg.text);
    }
  }, []), onConnected);

  useWebSocket(WS_DECISIONS, useCallback((msg) => {
    if (msg.type === 'decision') setDecisions((p) => [...p, msg]);
  }, []), onConnected);

  const handleCapture = useCallback(async (b64) => {
    setCapturing(true);
    try {
      const res  = await fetch(`${API}/analyze-photo`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ image_b64: b64 }) });
      const data = await res.json();
      if (data.analysis) setVisionResult(data.analysis);
    } catch {
      alert('Vision server unreachable on port 7860.');
    } finally {
      setCapturing(false);
    }
  }, []);

  const latestDecision = decisions.length > 0 ? decisions[decisions.length - 1] : null;

  return (
    <div className="session-root">
      <header className="session-header">
        <div className="session-logo">Sidebar</div>
        <div className="session-divider" />
        <div className="session-case-name">{caseInfo.caseName}</div>
        <div className="session-status">
          <span className={`session-dot${connected ? ' session-dot-active' : ''}`} />
          <span className="session-status-label">{connected ? 'Session Active' : 'Connecting…'}</span>
        </div>
      </header>

      <div className="session-body">
        <div className="panel">
          <CameraPanel visionResult={visionResult} onCapture={handleCapture} capturing={capturing} />
        </div>
        <div className="panel transcript-panel">
          <TranscriptPanel entries={transcript} />
        </div>
        <div className="panel">
          <DecisionsPanel decisions={decisions} />
        </div>
      </div>

      <SidebarCharacter latestDecision={latestDecision} />
    </div>
  );
}

// ── Root ──────────────────────────────────────────────────────────────────────

export default function App() {
  const [step, setStep] = useState('case');
  const [caseInfo, setCaseInfo] = useState(null);

  return (
    <div className="app">
      {step === 'case' && <OpenCasePage onNext={(info) => { setCaseInfo(info); setStep('brief'); }} />}
      {step === 'brief' && <UploadBriefsPage caseInfo={caseInfo} onNext={() => setStep('session')} />}
      {step === 'session' && <SessionPage caseInfo={caseInfo} />}
    </div>
  );
}
