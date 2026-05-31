# Sidebar — AI Co-Counsel for the Courtroom

## 1. What is this?

Sidebar is a real-time AI legal co-pilot that listens to courtroom testimony 
and whispers actionable intelligence to the lawyer — hands-free, eyes-forward.

The lawyer loads a case brief before the hearing. During testimony, Sidebar 
continuously monitors everything said, automatically fact-checks claims against 
real-world data, cross-references testimony against the brief, analyzes witness 
facial expressions for stress signals, and speaks findings directly to the lawyer 
as short sharp whispers — without being asked.

When a defendant claims they were at Macy's at 1am, Sidebar searches in real time, 
finds Macy's closes at 9pm, and immediately tells the lawyer: "Challenge the alibi, 
Macy's closes at 9." The lawyer never touches a phone. The lawyer never breaks eye 
contact. Sidebar handles the intelligence layer.

Built for the YC Voice Agents Hackathon, May 30 2026.

---

## 2. Demo Video

https://youtu.be/raY3BKP0-3g

---

## 3. How we used Pipecat, Nemotron, and Cekura

**Pipecat**
Sidebar is built entirely on Pipecat as the voice orchestration layer. 
The pipeline runs: NVIDIA Nemotron ASR → LLM co-counsel → Gradium TTS, 
all wired through Pipecat's SmallWebRTC transport for low-latency real-time 
audio. We use Pipecat's frame processor architecture to hook into transcript 
events and trigger our autonomous claim monitor without blocking the main 
voice pipeline.

**NVIDIA Nemotron**
We use Nemotron 3 Super 120B as the legal reasoning LLM and NVIDIA's Nemotron 
ASR for speech-to-text. The 120B model handles the complex cross-referencing 
task — holding the full case brief in context, tracking everything said, and 
deciding when and how to intervene. We found Nemotron ASR to be extremely fast 
with low latency which is critical for a real-time courtroom use case. 
One limitation: Nemotron was sometimes reluctant to call tools autonomously, 
which we worked around by adding a lightweight GPT-4o-mini claim detector that 
runs in parallel and force-triggers fact_check when a verifiable claim is heard. 
We'd love to see Nemotron improve on proactive tool-calling without needing 
explicit prompting.

**Cekura**
We used Cekura to evaluate Sidebar across adversarial courtroom scenarios — 
simulating hostile witnesses, prepared alibis, and procedural objections. 
The eval runs surfaced two key failure modes we then fixed: the agent was 
intervening too often on non-actionable statements, and it was sometimes 
narrating its own actions out loud instead of just delivering the verdict. 
We iterated on the system prompt using Cekura transcripts as ground truth 
until the agent reliably stayed silent when nothing was actionable and spoke 
only when it had something the lawyer could use. The transcript scoring was 
particularly useful — seeing exactly where the agent broke character helped 
us write much tighter behavioral rules than we would have caught through 
manual testing alone.

---

## 4. What we built during the hackathon

Everything. Built from scratch on May 30 2026 during the hackathon:

- Full Pipecat voice pipeline with Nemotron ASR + LLM + Gradium TTS
- Autonomous claim monitor using GPT-4o-mini as a parallel fact detector
- Real-time fact_check tool with web search for live verification
- Facial expression analysis using FER library + GPT-4o for courtroom-relevant 
  demeanor interpretation
- 3-step React web app: case intake, brief upload, live session
- Live evidence connection graph that builds in real time as the agent makes 
  connections between testimony and case facts
- Animated lawyer character (Sidebar) that displays agent speech in real time
- Case brief PDF parsing and injection into agent context
- Silence monitor that proactively suggests questions from the brief when 
  the lawyer goes quiet

---

## 5. Tool feedback

**NVIDIA Nemotron**
The ASR is genuinely impressive — fast, accurate, handles courtroom vocabulary 
well. The LLM is strong at legal reasoning and holding long context. Main pain 
point: tool-calling reliability. Nemotron would sometimes hear a clear verifiable 
claim and return a silent ✓ instead of calling fact_check. We had to build a 
parallel GPT-4o-mini layer as a workaround. If Nemotron's tool-calling could be 
made more aggressive and reliable without explicit prompting, it would be a much 
stronger fit for autonomous agent use cases.

**Cekura**
The scenario generation was excellent — it surfaced edge cases we hadn't thought 
of, particularly around the agent speaking at the wrong time. The scoring rubric 
for voice agents felt slightly tuned toward response quality over response 
appropriateness (sometimes silence is the correct response, which is hard to score). 
The Pipecat integration worked smoothly. Would love a way to score "correct silence" 
as a positive outcome in future eval runs.

**Pipecat**
Solid framework — the frame processor architecture is well designed and made it 
easy to hook into the pipeline without breaking existing behavior. The SmallWebRTC 
transport worked reliably. Documentation could be clearer on how to safely inject 
messages into an active pipeline from outside the frame processor chain.

---

## 6. Tech stack

- **Orchestration:** Pipecat
- **STT:** NVIDIA Nemotron ASR
- **LLM:** NVIDIA Nemotron 3 Super 120B
- **TTS:** Gradium
- **Vision:** FER (facial expression recognition) + GPT-4o
- **Fact checking:** GPT-4o-mini + OpenAI web search
- **Frontend:** React
- **Backend:** FastAPI + Python
- **Transport:** SmallWebRTC (local) / Twilio (telephony)
