import React, { useCallback, useEffect, useRef, useState } from 'react';
import './App.css';
import lawyerImg from './lawyer.png';
import EvidenceGraph from './EvidenceGraph';

const API = 'http://localhost:7860';
const WS_TRANSCRIPT = 'ws://localhost:7860/ws/transcript';
const WS_DECISIONS  = 'ws://localhost:7860/ws/decisions';
// Glasses-streaming server (server/main.py). The /viewer socket fans out the
// live Ray-Ban JPEG frames to the browser.
const RAYBAN_VIEWER = 'ws://localhost:8000/viewer';

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

// ── Icons ─────────────────────────────────────────────────────────────────────

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

// ── Step 1 ────────────────────────────────────────────────────────────────────

function OpenCasePage({ onNext }) {
  const [form, setForm] = useState({ caseName: '', defendantName: '', charges: '', jurisdiction: '' });
  const set = (k) => (e) => setForm((p) => ({ ...p, [k]: e.target.value }));

  return (
    <div className="step-page">
      <h1 className="step-hero-title">Sidebar</h1>
      <p className="step-hero-sub" style={{ fontSize: '14px', opacity: 0.65 }}>AKA Quick Whisper In The Courtroom...</p>
      <div className="step-layout">
        <div className="step-card">
          <h2 className="step-title">Open A Case</h2>
          <div className="step-counter">1 / 3</div>
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
  const [files, setFiles]       = useState([]);
  const [notes, setNotes]       = useState('');
  const [dragging, setDragging] = useState(false);
  const [saving, setSaving]     = useState(false);
  const [saved, setSaved]       = useState(false);
  const inputRef         = useRef(null);
  const evidenceInputRef = useRef(null);
  const [evidenceStatus, setEvidenceStatus] = useState('');

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

  const uploadEvidence = useCallback((file) => {
    if (!file) return;
    const MAX_BYTES = 35 * 1024 * 1024;
    if (file.size > MAX_BYTES) {
      setEvidenceStatus('Too large (max 35MB)');
      setTimeout(() => setEvidenceStatus(''), 4000);
      return;
    }
    setEvidenceStatus(file.type.startsWith('video/') ? 'Analyzing video…' : 'Analyzing…');
    const reader = new FileReader();
    reader.onload = async (ev) => {
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
        </div>
        <StepCharacter bubble="Brief me on everything." />
      </div>
    </div>
  );
}

// ── Camera panel ──────────────────────────────────────────────────────────────

function CameraPanel({ visionResult, onVisionUpdate }) {
  const videoRef     = useRef(null);
  const imgRef       = useRef(null);
  const canvasRef    = useRef(null);
  const macStreamRef = useRef(null);
  const objUrlRef    = useRef(null);
  const [source,       setSource]       = useState('mac'); // 'mac' | 'rayban'
  const [streaming,    setStreaming]    = useState(false);
  const [raybanStatus, setRaybanStatus] = useState('connecting'); // 'connecting' | 'live' | 'error'
  const [emotionBadge, setEmotionBadge] = useState(null);

  // ── Mac webcam ────────────────────────────────────────────────────────────
  const enableCamera = useCallback(() => {
    navigator.mediaDevices.getUserMedia({ video: true, audio: false })
      .then((stream) => {
        macStreamRef.current = stream;
        if (videoRef.current) { videoRef.current.srcObject = stream; setStreaming(true); }
      })
      .catch((err) => console.error('Camera:', err));
  }, []);

  const stopMacStream = useCallback(() => {
    macStreamRef.current?.getTracks().forEach((t) => t.stop());
    macStreamRef.current = null;
    if (videoRef.current) videoRef.current.srcObject = null;
  }, []);

  // Switching source tears down the previous one and resets per-source UI state.
  const switchSource = useCallback((next) => {
    setSource((cur) => {
      if (next === cur) return cur;
      setStreaming(false);
      setEmotionBadge(null);
      if (next === 'rayban') stopMacStream();   // leaving Mac → release the webcam
      return next;
    });
  }, [stopMacStream]);

  // ── Ray-Ban glasses feed (server/main.py /viewer) ─────────────────────────
  useEffect(() => {
    if (source !== 'rayban') return;
    setRaybanStatus('connecting');
    const ws = new WebSocket(RAYBAN_VIEWER);
    ws.binaryType = 'arraybuffer';
    ws.onmessage = (e) => {
      if (!(e.data instanceof ArrayBuffer)) return; // ignore any control text
      const url = URL.createObjectURL(new Blob([e.data], { type: 'image/jpeg' }));
      if (objUrlRef.current) URL.revokeObjectURL(objUrlRef.current); // no per-frame leak
      objUrlRef.current = url;
      if (imgRef.current) imgRef.current.src = url;
      setRaybanStatus('live');
      setStreaming(true);
    };
    ws.onerror = () => setRaybanStatus('error');
    ws.onclose = () => setStreaming(false);
    return () => {
      ws.close();
      if (objUrlRef.current) { URL.revokeObjectURL(objUrlRef.current); objUrlRef.current = null; }
    };
  }, [source]);

  // Release the webcam if the panel unmounts mid-session.
  useEffect(() => () => stopMacStream(), [stopMacStream]);

  const captureFrame = useCallback(() => {
    const cv = canvasRef.current;
    const el = source === 'rayban' ? imgRef.current : videoRef.current;
    if (!cv || !el) return null;
    const w = (source === 'rayban' ? el.naturalWidth  : el.videoWidth)  || 640;
    const h = (source === 'rayban' ? el.naturalHeight : el.videoHeight) || 480;
    cv.width = w; cv.height = h;
    cv.getContext('2d').drawImage(el, 0, 0, w, h);
    return cv.toDataURL('image/jpeg', 0.7).split(',')[1];
  }, [source]);

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
    <div className="camera-block">
      <div className="cam-source-toggle">
        <button className={source === 'mac'    ? 'cam-src-active' : ''} onClick={() => switchSource('mac')}>Mac Camera</button>
        <button className={source === 'rayban' ? 'cam-src-active' : ''} onClick={() => switchSource('rayban')}>Ray-Ban Glasses</button>
      </div>
      <div className="webcam-wrapper">
        <video ref={videoRef} autoPlay playsInline muted style={{ display: source === 'mac' ? 'block' : 'none' }} />
        <img ref={imgRef} alt="Ray-Ban glasses feed" style={{ display: source === 'rayban' ? 'block' : 'none', width: '100%', height: '100%', objectFit: 'cover' }} />
        {source === 'mac'    && !streaming && <button className="btn-enable-camera" onClick={enableCamera}>Enable Camera</button>}
        {source === 'rayban' && raybanStatus !== 'live' && (
          <div className="rayban-status">
            {raybanStatus === 'error' ? 'Cannot reach glasses server (:8000)' : 'Waiting for glasses video…'}
          </div>
        )}
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
    </div>
  );
}

// ── Transcript panel ──────────────────────────────────────────────────────────

function TranscriptPanel({ entries }) {
  const endRef = useRef(null);
  useEffect(() => { endRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [entries]);

  return (
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
  );
}

// ── Session page ──────────────────────────────────────────────────────────────

function SessionPage({ caseInfo }) {
  const [transcript,      setTranscript]      = useState([]);
  const [decisions,       setDecisions]       = useState([]);
  const [visionResult,    setVisionResult]    = useState('');
  const [connected,       setConnected]       = useState(false);
  const [bubbleText,      setBubbleText]      = useState('Monitoring…');
  const [agentBouncing,   setAgentBouncing]   = useState(false);
  const [transcriptOpen,  setTranscriptOpen]  = useState(false);
  const [briefFacts,      setBriefFacts]      = useState(null); // null = loading
  const bounceTimer  = useRef(null);
  const agentBubble  = useRef({ words: [], wordIdx: 0, lastMsgAt: 0, typingTimer: null, freezeTimer: null, fadeTimer: null });

  // Fetch case brief facts on mount to seed the evidence graph
  useEffect(() => {
    fetch(`${API}/brief-facts`)
      .then(r => r.json())
      .then(d => setBriefFacts(d.facts || []))
      .catch(() => setBriefFacts([]));
  }, []);

  const onConnected    = useCallback(() => setConnected(true), []);
  const onVisionUpdate = useCallback((a) => setVisionResult(a), []);

  useWebSocket(WS_TRANSCRIPT, useCallback((msg) => {
    if (msg.type === 'transcript') {
      setTranscript((p) => [...p, msg]);
      if (msg.role !== 'user' && msg.text) {
        const b = agentBubble.current;
        const now = Date.now();
        const isNewTurn = now - b.lastMsgAt > 2000;

        clearInterval(b.typingTimer);
        clearTimeout(b.freezeTimer);
        clearTimeout(b.fadeTimer);

        b.lastMsgAt = now;
        const incoming = msg.text.trim().split(/\s+/);
        if (isNewTurn) {
          b.words = incoming;
          b.wordIdx = 0;
        } else {
          // Same turn: extend word list from current position
          b.words = [...b.words.slice(0, b.wordIdx), ...incoming];
        }

        setAgentBouncing(true);
        clearTimeout(bounceTimer.current);
        bounceTimer.current = setTimeout(() => setAgentBouncing(false), 650);

        b.typingTimer = setInterval(() => {
          if (b.wordIdx >= b.words.length) {
            clearInterval(b.typingTimer);
            // Freeze for 2s, then fade after 8s more
            b.freezeTimer = setTimeout(() => {
              b.fadeTimer = setTimeout(() => setBubbleText('Monitoring…'), 8000);
            }, 2000);
            return;
          }
          setBubbleText(b.words.slice(0, b.wordIdx + 1).join(' '));
          b.wordIdx += 1;
        }, 80);
      }
    } else if (msg.type === 'vision') {
      setVisionResult(msg.text);
    }
  }, []), onConnected);

  useWebSocket(WS_DECISIONS, useCallback((msg) => {
    if (msg.type === 'decision') setDecisions((p) => [...p, msg]);
  }, []), onConnected);

  useEffect(() => () => {
    clearTimeout(bounceTimer.current);
    const b = agentBubble.current;
    clearInterval(b.typingTimer);
    clearTimeout(b.freezeTimer);
    clearTimeout(b.fadeTimer);
  }, []);

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

        {/* LEFT — camera + demeanor + collapsible transcript */}
        <div className="col-left">
          <CameraPanel visionResult={visionResult} onVisionUpdate={onVisionUpdate} />
          <div className="transcript-section">
            <button className="transcript-toggle" onClick={() => setTranscriptOpen(o => !o)}>
              {transcriptOpen ? 'Transcript ▲' : 'View Transcript ▼'}
            </button>
            {transcriptOpen && (
              <div className="transcript-drawer">
                <TranscriptPanel entries={transcript} />
              </div>
            )}
          </div>
        </div>

        {/* CENTER — live evidence graph */}
        <div className="col-center-graph">
          <EvidenceGraph decisions={decisions} briefFacts={briefFacts} />
        </div>

        {/* RIGHT — character + speech bubble */}
        <div className="col-right-char">
          <div className="right-stage">
            <div className="right-bubble">
              {bubbleText}
            </div>
            <img
              src={lawyerImg}
              alt="Sidebar"
              className={`right-char-img${agentBouncing ? ' char-bouncing' : ''}`}
            />
            <div className="right-char-label">Sidebar</div>
          </div>
        </div>

      </div>
    </div>
  );
}

// ── Root ──────────────────────────────────────────────────────────────────────

export default function App() {
  const [step, setStep] = useState('case');
  const [caseInfo, setCaseInfo] = useState(null);

  return (
    <div className="app">
      {step === 'case'    && <OpenCasePage onNext={(info) => { setCaseInfo(info); setStep('brief'); }} />}
      {step === 'brief'   && <UploadBriefsPage caseInfo={caseInfo} onNext={() => setStep('session')} />}
      {step === 'session' && <SessionPage caseInfo={caseInfo} />}
    </div>
  );
}
