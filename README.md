# Sidebar — AI Co-Counsel for the Courtroom

## 1. What is this?

Sidebar is a real-time AI legal co-pilot that listens to live courtroom 
testimony and whispers actionable intelligence to the lawyer — hands-free, 
eyes-forward, no phone required.

The lawyer loads a case brief before the hearing. During testimony, Sidebar 
continuously monitors everything said, automatically fact-checks claims 
against real-world data, cross-references testimony against the brief, 
analyzes witness facial expressions for stress signals, and speaks findings 
directly to the lawyer as short sharp whispers — without being asked.

**The demo moment:** A defendant claims he was at Macy's at 1am. Sidebar 
searches in real time, finds Macy's closes at 9pm, and immediately tells 
the lawyer: *"Challenge the alibi, Macy's closes at 9."* The lawyer never 
touches a phone. The lawyer never breaks eye contact. Sidebar handles the 
intelligence layer.

This reframes what voice agents are for. Not outbound calls. Not customer 
service. A real-time human lifeline in the highest-stakes moments people face.

Built in one day at the YC Voice Agents Hackathon, May 30 2026.

---

## 2. Demo Video

https://youtu.be/raY3BKP0-3g

[![Sidebar Demo](https://img.youtube.com/vi/raY3BKP0-3g/0.jpg)](https://youtu.be/raY3BKP0-3g)

---

## 3. How we used Pipecat, Nemotron, and Cekura

**Pipecat**
Sidebar is built entirely on Pipecat as the voice orchestration layer. 
The pipeline runs: NVIDIA Nemotron ASR → Nemotron 3 Super 120B LLM → 
Gradium TTS, wired through Pipecat's SmallWebRTC transport for 
low-latency real-time audio. We use Pipecat's frame processor 
architecture to hook into transcript events and trigger our autonomous 
claim monitor without blocking the main voice pipeline. The event 
handler system (on_user_turn_stopped, on_bot_started_speaking) gave us 
clean hooks to build the interruption buffer and silence monitor on top of.

**NVIDIA Nemotron**
We use Nemotron 3 Super 120B as the primary legal reasoning LLM and 
NVIDIA Nemotron ASR for speech-to-text. The 120B model holds the full 
case brief in context, tracks the running transcript, and decides when 
to intervene. Nemotron ASR was genuinely impressive — fast, accurate, 
handles legal vocabulary and proper nouns cleanly, and the latency was 
low enough to feel real-time in a live conversation.

The main challenge we hit: Nemotron was sometimes reluctant to call 
tools proactively. It would hear a clear verifiable claim and return a 
silent acknowledgment instead of firing fact_check. We worked around 
this by building a parallel GPT-4o-mini claim detector that runs on 
every transcript and force-triggers fact_check when a verifiable claim 
is detected — bypassing the LLM's hesitation. This hybrid approach 
(Nemotron for reasoning, GPT-4o-mini for trigger detection) ended up 
being more reliable than either alone.

**Cekura**
We used Cekura to evaluate Sidebar across adversarial courtroom 
scenarios — simulating hostile witnesses, prepared alibis, and 
procedural objections. The eval runs surfaced two key failure modes 
we then fixed: the agent was intervening too often on non-actionable 
statements, and it was sometimes narrating its own actions out loud 
instead of just delivering the verdict. We iterated on the system 
prompt using Cekura transcripts as ground truth until the agent 
reliably stayed silent when nothing was actionable and spoke only 
when it had something the lawyer could use. The transcript scoring 
was particularly useful — seeing exactly where the agent broke 
character helped us write much tighter behavioral rules than we 
would have caught through manual testing alone.

---

## 4. What we built during the hackathon

Everything. Built from scratch on May 30 2026:

- Full Pipecat voice pipeline: Nemotron ASR + Nemotron 120B LLM + Gradium TTS
- Autonomous claim monitor — GPT-4o-mini runs on every transcript to 
  detect verifiable claims and force-trigger fact_check without waiting 
  for the LLM to decide
- Real-time fact_check tool using OpenAI web search — checks alibis, 
  business hours, locations, dates against live web data
- Evidence contradiction detector — cross-references live testimony 
  against the loaded case brief and flags inconsistencies immediately
- Facial expression analysis — FER library runs continuous local emotion 
  detection on the witness, GPT-4o interprets signals in legal context, 
  agent speaks up when stress indicators spike during key claims
- Silence monitor — if 15 seconds pass with no intervention, agent 
  proactively suggests the most damaging unused question from the brief
- Evidence connection graph — live SVG visualization that builds in 
  real time showing how testimony connects to brief facts, with 
  color-coded contradiction and match nodes
- 3-step React web app: case intake → brief upload (PDF/text) → live session
- Animated lawyer character that displays agent speech in real time
- Interruption buffer — prevents the agent from cutting itself off 
  mid-sentence when new transcript arrives while it is speaking

---

## 5. Tool feedback

**NVIDIA Nemotron**
ASR: genuinely strong. Fast, accurate on legal vocabulary, low latency — 
exactly what a real-time use case needs. No complaints.

LLM: strong at legal reasoning and holding long context. The main gap is 
proactive tool-calling. For an autonomous agent that is supposed to act 
without being asked, Nemotron was too conservative — it would correctly 
identify a claim but choose not to call the tool. This forced us to build 
a workaround. If Nemotron's tool-calling behavior could be tuned to be 
more aggressive in agentic contexts (separate from conversational contexts 
where conservative is correct), it would be a much stronger fit for 
autonomous agent use cases. A system-prompt-level flag like 
"tool-calling-mode: aggressive" would be valuable.

**Cekura**
Scenario generation was the standout feature — it created adversarial 
test cases we hadn't thought of. The Pipecat integration was smooth. 

One piece of feedback: the scoring rubric rewards response quality but 
has no clean way to reward correct silence. For our use case, staying 
silent when nothing is actionable is the right behavior — but it scores 
the same as a wrong response. A "silence was correct here" label in the 
eval UI would make the platform much more useful for agents that are 
designed to be selective rather than always-on.

No bugs found, but the dashboard could surface which specific transcript 
moments triggered a low score more directly — right now you have to read 
the full transcript to find the failure point.

**Pipecat**
Solid framework. The frame processor architecture is well designed and 
composable. SmallWebRTC worked reliably throughout the day. 

Documentation gap: injecting messages into an active pipeline from 
outside the frame processor chain (e.g. from an async background task) 
is not well documented. We figured it out but it took time. A clear 
example of "how to trigger an LLM response from outside the pipeline" 
would save future builders significant debugging time.

---

## 6. Tech stack

| Layer | Technology |
|-------|-----------|
| Orchestration | Pipecat |
| STT | NVIDIA Nemotron ASR |
| LLM | NVIDIA Nemotron 3 Super 120B |
| TTS | Gradium |
| Claim detection | GPT-4o-mini |
| Vision / demeanor | FER (local) + GPT-4o |
| Fact checking | OpenAI web search tool |
| Frontend | React |
| Backend | FastAPI + Python |
| Transport | SmallWebRTC |
