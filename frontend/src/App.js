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
    <svg width="13" height="13" viewBox="0 0 13 13" fill="none" style={{flexShrink:0}}>
      <rect x="1.5" y="1" width="10" height="11" rx="1.5" stroke="currentColor" strokeWidth="1.4"/>
      <path d="M3.5 4h6M3.5 6.5h6M3.5 9h4" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"/>
    </svg>
  );
}
function IconSearch() {
  return (
    <svg width="13" height="13" viewBox="0 0 13 13" fill="none" style={{flexShrink:0}}>
      <circle cx="5.5" cy="5.5" r="3.5" stroke="currentColor" strokeWidth="1.4"/>
      <path d="M8.5 8.5l3 3" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"/>
    </svg>
  );
}
function IconBubble() {
  return (
    <svg width="13" height="13" viewBox="0 0 13 13" fill="none" style={{flexShrink:0}}>
      <path d="M1.5 1.5h10a.5.5 0 01.5.5v6a.5.5 0 01-.5.5H7.5l-2 2-2-2H1.5a.5.5 0 01-.5-.5V2a.5.5 0 01.5-.5z" stroke="currentColor" strokeWidth="1.4"/>
    </svg>
  );
}
function IconEye() {
  return (
    <svg width="13" height="13" viewBox="0 0 13 13" fill="none" style={{flexShrink:0}}>
      <path d="M1 6.5C2.5 3.5 4.8 2 6.5 2S10.5 3.5 12 6.5C10.5 9.5 8.2 11 6.5 11S2.5 9.5 1 6.5z" stroke="currentColor" strokeWidth="1.4"/>
      <circle cx="6.5" cy="6.5" r="1.8" stroke="currentColor" strokeWidth="1.4"/>
    </svg>
  );
}
function IconClip() {
  return (
    <svg width="13" height="13" viewBox="0 0 13 13" fill="none" style={{flexShrink:0}}>
      <path d="M9.5 3.5L4 9a1.8 1.8 0 002.5 2.5l5-5a3 3 0 00-4.2-4.2l-5 5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"/>
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

// ── Step-page character ───────────────────────────────────────────────────────

function StepCharacter({ bubble }) {
  return (
    <div className="step-char-side">
      <div className="step-char-bubble">{bubble}</div>
      <img src={lawyerImg} alt="Sidebar" className="step-char-img" />
    </div>
  );
}

// ── Session character — bottom-right, float, live bubble ─────────────────────

function SidebarCharacter({ latestDecision }) {
  const [bubble,   setBubble]   = useState('Monitoring...');
  const [bouncing, setBouncing] = useState(false);
  const prevRef  = useRef(null);
  const timerRef = useRef(null);

  useEffect(() => {
    if (!latestDecision) return;
    const key = latestDecision.timestamp;
    if (key === prevRef.current) return;
    prevRef.current = key;

    const raw = latestDecision.utterance.replace(/^\(.*?\)\s*/, '').trim();
    if (!raw) return;

    const text = raw.length > 160 ? raw.slice(0, 157) + '…' : raw;
    setBubble(text);
    setBouncing(true);
    setTimeout(() => setBouncing(false), 650);
    clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => setBubble('Monitoring...'), 5000);
  }, [latestDecision]);

  useEffect(() => () => clearTimeout(timerRef.current), []);

  return (
    <div className="character-wrap">
      <div className="character-bubble">{bubble}</div>
      <img
        src={lawyerImg}
        alt="Sidebar"
        className={`character-img${bouncing ? ' character-bouncing' : ''}`}
      />
      <div className="character-name">Sidebar</div>
    </div>
  );
}

// ── Step 1 ────────────────────────────────────────────────────────────────────

function OpenCasePage({ onNext }) {
  const [form, setForm] = useState({ caseName: '', defendantName: '', charges: '', jurisdiction: '' });
  const set = (k) => (e) => setForm((p) => ({ ...p, [k]: e.target.value }));

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

// ── Step 2 ────────────────────────────────────────────────────────────────────

function UploadBriefsPage({ caseInfo, onNext }) {
  const [files, setFiles]     = useState([]);
  const [notes, setNotes]     = useState('');
  const [dragging, setDragging] = useState(false);
  const [saving, setSaving]   = useState(false);
  const [saved, setSaved]     = useState(false);
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
          <div className="form-field" style={{ marginTop: 22 }}>
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

// ── Camera panel ──────────────────────────────────────────────────────────────

function CameraPanel({ visionResult, onVisionUpdate }) {
  const videoRef  = useRef(null);
  const canvasRef = useRef(null);
  const evidenceInputRef = useRef(null);
  const [streaming,    setStreaming]    = useState(false);
  const [emotionBadge, setEmotionBadge] = useState(null);
  const [evidenceStatus, setEvidenceStatus] = useState('');

  // Upload an exhibit image OR video — Gemini describes/OCRs it server-side,
  // adds it to the case knowledge, and the live agent reacts in real time.
  const uploadEvidence = useCallback((file) => {
    if (!file) return;
    const MAX_BYTES = 35 * 1024 * 1024; // ~35MB raw ≈ 47MB base64, under Gemini's inline cap
    if (file.size > MAX_BYTES) {
      setEvidenceStatus('Too large (max 35MB)');
      setTimeout(() => setEvidenceStatus(''), 4000);
      return;
    }
    setEvidenceStatus(file.type.startsWith('video/') ? 'Analyzing video…' : 'Analyzing…');
    const reader = new FileReader();
    reader.onload = async (ev) => {
      // Send the full data-URI so the server keeps the real MIME type (PNG/WebP/JPEG).
      try {
        const res  = await fetch(`${API}/evidence`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ image_b64: ev.target.result, label: file.name }),
        });
        const data = await res.json();
        setEvidenceStatus(data.error ? 'Failed' : 'Evidence added ✓');
      } catch (e) {
        console.error('Evidence upload:', e);
        setEvidenceStatus('Failed');
      }
      setTimeout(() => setEvidenceStatus(''), 4000);
    };
    reader.readAsDataURL(file);
  }, []);

  const enableCamera = useCallback(() => {
    navigator.mediaDevices.getUserMedia({ video: true, audio: false })
      .then((stream) => { if (videoRef.current) { videoRef.current.srcObject = stream; setStreaming(true); } })
      .catch((err) => console.error('Camera:', err));
  }, []);

  const captureFrame = useCallback(() => {
    if (!videoRef.current || !canvasRef.current) return null;
    const cv = canvasRef.current;
    cv.width  = videoRef.current.videoWidth  || 640;
    cv.height = videoRef.current.videoHeight || 480;
    cv.getContext('2d').drawImage(videoRef.current, 0, 0);
    return cv.toDataURL('image/jpeg', 0.7).split(',')[1];
  }, []);

  // Auto-monitor every 5 seconds — clearInterval on unmount
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
        if (data.emotion) setEmotionBadge({ emotion: data.emotion, confidence: data.confidence, flagged: data.flagged });
        if (data.analysis) onVisionUpdate(data.analysis);
      } catch (e) { console.error('Auto-monitor:', e); }
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

        {emotionBadge ? (
          <div className={`emotion-badge ${emotionBadgeClass(emotionBadge.emotion)}`}>
            {emotionBadge.emotion.toUpperCase()} {emotionBadge.confidence}%
            {emotionBadge.flagged && <span className="em-flag"> !</span>}
          </div>
        ) : (
          <div className="emotion-badge em-gray">—</div>
        )}

        <div className="vision-card">
          <div className="vision-card-label">Demeanor</div>
          {visionResult
            ? <div className="vision-card-text">{visionResult}</div>
            : <div className="vision-card-empty">Monitoring…</div>}
        </div>

        <div className="evidence-controls">
          <button className="btn-evidence" onClick={() => evidenceInputRef.current?.click()}>
            <IconClip /> Add Evidence
          </button>
          {evidenceStatus && (
            <span className={`evidence-status${/added ✓$/.test(evidenceStatus) ? '' : evidenceStatus.startsWith('Analyz') ? '' : ' evidence-status-err'}`}>
              {evidenceStatus}
            </span>
          )}
          <input
            ref={evidenceInputRef}
            type="file"
            accept=".jpg,.jpeg,.png,.webp,.mp4,.mov,.webm,.m4v"
            style={{ display: 'none' }}
            onChange={(e) => { uploadEvidence(e.target.files[0]); e.target.value = ''; }}
          />
        </div>
      </div>
    </>
  );
}

// ── Transcript panel — spoken words only, no demeanor cards ──────────────────

function TranscriptPanel({ entries }) {
  const endRef = useRef(null);
  useEffect(() => { endRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [entries]);

  return (
    <>
      <div className="panel-header">Live Transcript</div>
      <div className="transcript-scroll">
        {entries.length === 0 && <div className="panel-empty">Spoken words will appear here.</div>}
        {entries.map((e, i) => {
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

// ── Decisions panel — collapsible, newest on top ──────────────────────────────

function DecisionCard({ d }) {
  const tool    = d.tool_fired || 'direct';
  const verdict = d.verdict || (tool === 'fact_check' ? verdictFromText(d.utterance) : null);
  const slug    = tool.replace('_', '-');

  const icon = { recall: <IconBook />, search: <IconSearch />, camera: <IconEye />, evidence: <IconClip />, direct: <IconBubble /> }[tool] ?? <IconBubble />;

  return (
    <div className={`decision-card dc-${slug}`}>
      <div className="dc-top">
        <span className={`dc-tool-badge tb-${slug}`}>{icon}{tool.replace('_', ' ').toUpperCase()}</span>
        {verdict && <span className={`dc-verdict vd-${verdict.toLowerCase()}`}>{verdict}</span>}
        <span className="decision-ts">{formatTs(d.timestamp)}</span>
      </div>
      {d.claim && <div className="dc-claim">"{d.claim}"</div>}
      <div className="decision-utterance">{d.utterance}</div>
    </div>
  );
}

function DecisionsPanel({ decisions }) {
  const [collapsed, setCollapsed] = useState(false);
  // newest on top
  const sorted = [...decisions].reverse();

  return (
    <>
      <div className="panel-header intel-header">
        <span>Sidebar Intel</span>
        <button className="intel-toggle" onClick={() => setCollapsed(c => !c)} title={collapsed ? 'Expand' : 'Collapse'}>
          {collapsed ? '▼' : '▲'}
        </button>
      </div>
      {collapsed ? (
        <div className="intel-icons">
          {sorted.slice(0, 14).map((d, i) => (
            <div
              key={i}
              className={`intel-dot tb-${(d.tool_fired || 'direct').replace('_', '-')}`}
              title={d.utterance}
            />
          ))}
          {sorted.length === 0 && <div className="intel-dots-empty">—</div>}
        </div>
      ) : (
        <div className="decisions-scroll">
          {sorted.length === 0 && <div className="panel-empty">Sidebar interventions will appear here.</div>}
          {sorted.map((d, i) => <DecisionCard key={i} d={d} />)}
        </div>
      )}
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
  const onVisionUpdate = useCallback((a) => setVisionResult(a), []);

  useWebSocket(WS_TRANSCRIPT, useCallback((msg) => {
    // Only add spoken transcript entries — demeanor (vision) updates the badge
    // silently via the HTTP response; exclude them from the chat panel.
    if (msg.type === 'transcript') {
      setTranscript((p) => [...p, msg]);
    } else if (msg.type === 'vision') {
      setVisionResult(msg.text);
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
