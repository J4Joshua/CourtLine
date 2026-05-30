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
function emotionBadgeClass(emotion) {
  const e = (emotion || '').toLowerCase();
  if (['fear','angry','disgust','contempt'].includes(e)) return 'em-red';
  if (e === 'surprise') return 'em-amber';
  return 'em-gray';
}
function verdictFromText(utterance) {
  const t = (utterance || '').toLowerCase();
  if (/\bfalse\b|impossible|closes at|closed at|wasn't open|not open|wrong|incorrect/.test(t)) return 'FALSE';
  if (/\btrue\b|confirmed|correct|accurate|verified/.test(t)) return 'TRUE';
  if (/unverifiable|can't confirm|could not verify|unclear|proceed with caution/.test(t)) return 'UNVERIFIABLE';
  return null;
}

// ── Icons ─────────────────────────────────────────────────────────────────────

function IconBook() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
      <rect x="1.5" y="1" width="11" height="12" rx="1.5" stroke="#7048e8" strokeWidth="1.5"/>
      <path d="M4 4.5h6M4 7h6M4 9.5h4" stroke="#7048e8" strokeWidth="1.2" strokeLinecap="round"/>
    </svg>
  );
}
function IconSearch() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
      <circle cx="6" cy="6" r="4" stroke="#0c7a5a" strokeWidth="1.5"/>
      <path d="M9.5 9.5l3 3" stroke="#0c7a5a" strokeWidth="1.5" strokeLinecap="round"/>
    </svg>
  );
}
function IconBubble() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
      <path d="M1.5 1.5h11a.5.5 0 01.5.5v7a.5.5 0 01-.5.5H8L6 12l-2-2.5H1.5A.5.5 0 011 9V2a.5.5 0 01.5-.5z" stroke="#1a1a2e" strokeWidth="1.5"/>
    </svg>
  );
}
function IconEye() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
      <path d="M1 7C2.5 4 5 2.5 7 2.5S11.5 4 13 7C11.5 10 9 11.5 7 11.5S2.5 10 1 7z" stroke="#b07d00" strokeWidth="1.5"/>
      <circle cx="7" cy="7" r="2" stroke="#b07d00" strokeWidth="1.5"/>
    </svg>
  );
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

// ── Step-page character (right side, static bubble) ──────────────────────────

function StepCharacter({ bubble }) {
  return (
    <div className="step-char-side">
      <div className="step-char-bubble">{bubble}</div>
      <img src={lawyerImg} alt="Sidebar" className="step-char-img" />
    </div>
  );
}

// ── Session character (bottom-right, float, live bubble) ─────────────────────

function SidebarCharacter({ latestDecision }) {
  const [bubble, setBubble] = useState('Monitoring...');
  const prevRef  = useRef(null);
  const timerRef = useRef(null);

  useEffect(() => {
    if (!latestDecision) return;
    const key = latestDecision.timestamp;
    if (key === prevRef.current) return;
    prevRef.current = key;

    // Strip internal "(tool fired)" messages — only show spoken verdicts
    const raw = latestDecision.utterance.replace(/^\(.*?\)\s*/, '').trim();
    if (!raw) return;

    const text = raw.length > 130 ? raw.slice(0, 127) + '…' : raw;
    setBubble(text);
    clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => setBubble('Monitoring...'), 5000);
  }, [latestDecision]);

  useEffect(() => () => clearTimeout(timerRef.current), []);

  return (
    <div className="character-wrap">
      <div className="character-bubble">{bubble}</div>
      <img src={lawyerImg} alt="Sidebar" className="character-img" />
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
      <div className="step-layout">
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
        <StepCharacter bubble="Let's build your case." />
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
      <div className="step-layout">
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
        <StepCharacter bubble="Brief me on everything." />
      </div>
    </div>
  );
}

// ── Camera panel (auto-monitoring, no manual capture button) ──────────────────

function CameraPanel({ visionResult, onVisionUpdate }) {
  const videoRef   = useRef(null);
  const canvasRef  = useRef(null);
  const [streaming, setStreaming] = useState(false);
  const [emotionBadge, setEmotionBadge] = useState(null);

  const enableCamera = useCallback(() => {
    navigator.mediaDevices.getUserMedia({ video: true, audio: false })
      .then((stream) => { if (videoRef.current) { videoRef.current.srcObject = stream; setStreaming(true); } })
      .catch((err) => console.error('Camera:', err));
  }, []);

  // Capture current frame as base64 JPEG
  const captureFrame = useCallback(() => {
    if (!videoRef.current || !canvasRef.current) return null;
    const cv = canvasRef.current;
    cv.width  = videoRef.current.videoWidth  || 640;
    cv.height = videoRef.current.videoHeight || 480;
    cv.getContext('2d').drawImage(videoRef.current, 0, 0);
    return cv.toDataURL('image/jpeg', 0.7).split(',')[1];
  }, []);

  // Auto-monitoring every 5 seconds — cleans up on unmount
  useEffect(() => {
    if (!streaming) return;

    const doCapture = async () => {
      const b64 = captureFrame();
      if (!b64) return;
      try {
        const res  = await fetch(`${API}/analyze-photo`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ image_b64: b64 }),
        });
        const data = await res.json();
        if (data.emotion) {
          setEmotionBadge({ emotion: data.emotion, confidence: data.confidence, flagged: data.flagged });
        }
        if (data.analysis) onVisionUpdate(data.analysis);
      } catch (e) {
        console.error('Auto-monitor:', e);
      }
    };

    const id = setInterval(doCapture, 5000);
    return () => clearInterval(id);
  }, [streaming, captureFrame, onVisionUpdate]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <>
      <div className="panel-header">Live Feed</div>
      <div className="camera-panel">
        <div className="webcam-wrapper">
          <video ref={videoRef} autoPlay playsInline muted />
          {!streaming && <button className="btn-enable-camera" onClick={enableCamera}>Enable Camera</button>}
        </div>
        <canvas ref={canvasRef} style={{ display: 'none' }} />

        {emotionBadge && (
          <div className={`emotion-badge ${emotionBadgeClass(emotionBadge.emotion)}`}>
            {emotionBadge.emotion.toUpperCase()} {emotionBadge.confidence}%
            {emotionBadge.flagged && <span className="em-flag"> !</span>}
          </div>
        )}

        <div className="vision-card">
          <div className="vision-card-label">Demeanor</div>
          {visionResult
            ? <div className="vision-card-text">{visionResult}</div>
            : <div className="vision-card-empty">Monitoring…</div>}
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

function DecisionCard({ d }) {
  const tool = d.tool_fired || 'direct';
  // verdict may come from the server payload or be parsed from the utterance
  const verdict = d.verdict || (tool === 'fact_check' ? verdictFromText(d.utterance) : null);

  const toolIcon = {
    recall:     <IconBook />,
    search:     <IconSearch />,
    camera:     <IconEye />,
    fact_check: null,
    direct:     <IconBubble />,
  }[tool] ?? <IconBubble />;

  return (
    <div className={`decision-card dc-${tool.replace('_', '-')}`}>
      <div className="dc-top">
        <span className={`dc-tool-badge tb-${tool.replace('_', '-')}`}>
          {toolIcon}
          {tool.replace('_', ' ').toUpperCase()}
        </span>
        {verdict && (
          <span className={`dc-verdict vd-${verdict.toLowerCase()}`}>{verdict}</span>
        )}
        <span className="decision-ts">{formatTs(d.timestamp)}</span>
      </div>
      {d.claim && <div className="dc-claim">"{d.claim}"</div>}
      <div className="decision-utterance">{d.utterance}</div>
    </div>
  );
}

function DecisionsPanel({ decisions }) {
  const endRef = useRef(null);
  useEffect(() => { endRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [decisions]);

  return (
    <>
      <div className="panel-header">Sidebar Intel</div>
      <div className="decisions-scroll">
        {decisions.length === 0 && <div className="panel-empty">Sidebar interventions will appear here.</div>}
        {decisions.map((d, i) => <DecisionCard key={i} d={d} />)}
        <div ref={endRef} />
      </div>
    </>
  );
}

// ── Session page ──────────────────────────────────────────────────────────────

function SessionPage({ caseInfo }) {
  const [transcript,   setTranscript]   = useState([]);
  const [decisions,    setDecisions]    = useState([]);
  const [visionResult, setVisionResult] = useState('');
  const [connected,    setConnected]    = useState(false);

  const onConnected    = useCallback(() => setConnected(true), []);
  const onVisionUpdate = useCallback((analysis) => setVisionResult(analysis), []);

  useWebSocket(WS_TRANSCRIPT, useCallback((msg) => {
    if (msg.type === 'transcript' || msg.type === 'vision') {
      setTranscript((p) => [...p, msg]);
      if (msg.type === 'vision') setVisionResult(msg.text);
    }
  }, []), onConnected);

  useWebSocket(WS_DECISIONS, useCallback((msg) => {
    if (msg.type === 'decision') setDecisions((p) => [...p, msg]);
  }, []), onConnected);

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
          <CameraPanel visionResult={visionResult} onVisionUpdate={onVisionUpdate} />
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
