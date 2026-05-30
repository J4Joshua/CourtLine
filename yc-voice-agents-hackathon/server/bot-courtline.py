"""Sidebar — autonomous AI legal co-pilot.

Pipeline: NVIDIA ASR STT → Nemotron-3-Super LLM → Gradium TTS
Tools: recall_case, search_legal, check_camera, fact_check
"""

import asyncio
import json
import os
import time
from datetime import date

from dotenv import load_dotenv
from loguru import logger
from pipecat.adapters.schemas.tools_schema import ToolsSchema
from pipecat.audio.vad.silero import SileroVADAnalyzer
from pipecat.frames.frames import (
    LLMFullResponseEndFrame,
    LLMFullResponseStartFrame,
    LLMRunFrame,
    LLMTextFrame,
)
from pipecat.pipeline.pipeline import Pipeline
from pipecat.pipeline.worker import PipelineParams, PipelineWorker
from pipecat.processors.aggregators.llm_context import LLMContext
from pipecat.processors.aggregators.llm_response_universal import (
    LLMContextAggregatorPair,
    LLMUserAggregatorParams,
)
from pipecat.processors.frame_processor import FrameDirection, FrameProcessor
from pipecat.runner.types import RunnerArguments, SmallWebRTCRunnerArguments
from pipecat.services.gradium.tts import GradiumTTSService
from pipecat.services.llm_service import FunctionCallParams
from pipecat.transports.base_transport import BaseTransport, TransportParams
from pipecat.transports.daily.transport import DailyParams
from pipecat.transports.smallwebrtc.connection import SmallWebRTCConnection
from pipecat.transports.smallwebrtc.transport import SmallWebRTCTransport
from pipecat.turns.user_turn_strategies import FilterIncompleteUserTurnStrategies
from pipecat.workers.runner import WorkerRunner
from openai import AsyncOpenAI

from nemotron_llm import VLLMOpenAILLMService
from nvidia_stt import NVidiaWebSocketSTTService
from case_store import state

load_dotenv(override=True)

_openai = AsyncOpenAI(api_key=os.environ.get("OPENAI_API_KEY", ""))

_turn_state: dict = {"fact_checked": False}


# ── Broadcast helpers ─────────────────────────────────────────────────────────

async def _broadcast_decision(
    utterance: str,
    tool_fired: str | None,
    verdict: str | None = None,
    claim: str | None = None,
):
    d = state.add_decision(utterance, tool_fired, verdict=verdict, claim=claim)
    payload = json.dumps({
        "type": "decision",
        "timestamp": d.timestamp,
        "utterance": utterance,
        "tool_fired": tool_fired,
        "verdict": verdict,
        "claim": claim,
    })
    dead = []
    for ws in state.decision_subscribers:
        try:
            await ws.send_text(payload)
        except Exception:
            dead.append(ws)
    for ws in dead:
        state.decision_subscribers.remove(ws)


async def _broadcast_transcript(role: str, text: str):
    entry = state.add_transcript(role, text)
    payload = json.dumps({"type": "transcript", **entry})
    dead = []
    for ws in state.transcript_subscribers:
        try:
            await ws.send_text(payload)
        except Exception:
            dead.append(ws)
    for ws in dead:
        state.transcript_subscribers.remove(ws)


def _word_similarity(a: str, b: str) -> float:
    wa, wb = set(a.lower().split()), set(b.lower().split())
    if not wa or not wb:
        return 0.0
    return len(wa & wb) / max(len(wa), len(wb))


def _extract_verdict(text: str) -> str | None:
    """Parse TRUE / FALSE / UNVERIFIABLE from an agent fact-check verdict."""
    t = text.lower()
    if any(w in t for w in ["false", "impossible", "closes at", "closed at", "wasn't open",
                             "not open", "wrong", "incorrect", "doesn't match"]):
        return "FALSE"
    if any(w in t for w in ["true", "confirmed", "correct", "accurate", "verified"]):
        return "TRUE"
    if any(w in t for w in ["can't confirm", "unverifiable", "could not verify", "unclear",
                             "proceed with caution"]):
        return "UNVERIFIABLE"
    return None


# ── Frame processor: buffer complete LLM response before broadcasting ─────────

class AgentResponseBroadcaster(FrameProcessor):
    """Buffers every LLMTextFrame between LLMFullResponseStart/EndFrame and
    broadcasts the COMPLETE assembled string only after the End marker.

    Fix 1: never broadcasts partial (mid-stream) text.
    Fix 2: tags the broadcast with the pending tool+claim tracked by run_bot.
    """

    def __init__(self, get_pending_tool):
        super().__init__()
        self._buf: list[str] = []
        self._get_pending_tool = get_pending_tool  # () -> (tool, claim)

    async def process_frame(self, frame, direction: FrameDirection):
        # super() handles StartFrame/EndFrame lifecycle (processor init/teardown)
        await super().process_frame(frame, direction)
        # Always forward every frame so the rest of the pipeline is unaffected
        await self.push_frame(frame, direction)

        if isinstance(frame, LLMFullResponseStartFrame):
            self._buf = []
            state.agent_speaking = True

        elif isinstance(frame, LLMTextFrame) and frame.text:
            self._buf.append(frame.text)

        elif isinstance(frame, LLMFullResponseEndFrame):
            state.agent_speaking = False
            text = "".join(self._buf).strip()
            self._buf = []
            if not text:
                return
            tool, claim = self._get_pending_tool()
            verdict = _extract_verdict(text) if tool == "fact_check" else None
            asyncio.create_task(_broadcast_transcript("agent", text))
            asyncio.create_task(_broadcast_decision(text, tool, verdict=verdict, claim=claim))


# ── System instruction ────────────────────────────────────────────────────────

SYSTEM_INSTRUCTION = f"""You are Sidebar. You listen to courtroom testimony and whisper to the lawyer only when you have something useful. You have the case brief memorized. Today is {date.today().strftime('%A, %B %d, %Y')}.

YOU ARE WHISPERING TO THE LAWYER ONLY. The lawyer is sitting next to you.
The defendant, witnesses, and judge cannot hear you.

NEVER say: "you", "your alibi", "you were", "you said", "you claim"
ALWAYS say: "his alibi", "Mickey said", "the defendant claims", "press him"

Wrong: "Your alibi is impossible because Macy's closes at 9."
Right: "Challenge him, Macy's closes at 9."
Wrong: "You were seen near the scene."
Right: "Goofy placed Mickey near the scene, use that."

You are never talking to the person on the stand. Ever.

SPEAK only when ONE of these is true:
- A witness states a verifiable fact you can check (location, time, business hours, date, distance) — check it and report the result
- A witness says something that contradicts the case brief — point it out
- The lawyer asks you something directly
- You have been silent for 10+ seconds AND there is an untouched fact in the brief worth questioning

NEVER speak to:
- Announce you are ready or monitoring
- Confirm you heard something
- Describe what you are about to do
- Respond to incomplete sentences or fragments
- Say "Sidebar ready" under any circumstances ever

WHEN you speak, say ONE sentence. Natural. Direct. Use real names from the brief.
Good: "Ask Mickey his shoe size."
Good: "Challenge the alibi, Macy's closes at 9."
Good: "GPS placed him on Webfoot Lane at 11:38, press him on that."
Bad: "Sidebar ready." — never say this
Bad: "I will now check the facts." — never say this
Bad: "Note: monitoring active." — never say this

When a witness answers a question you prompted: immediately confirm or contradict against the brief in one sentence.
"That matches the shoe print, press him."
"No match — the print is size 6.5, challenge that."
"Contradiction — GPS places him elsewhere at that time."

Silence is correct behavior. Only speak when it matters.
"""


# ── Bot pipeline ──────────────────────────────────────────────────────────────

async def run_bot(transport: BaseTransport):
    logger.info("Sidebar bot starting")

    # Tracks the most-recently-fired tool + claim so AgentResponseBroadcaster
    # can tag the complete response with the right tool_fired / claim.
    _pending: dict = {"tool": None, "claim": None}

    def get_pending_tool() -> tuple[str | None, str | None]:
        t, c = _pending["tool"], _pending["claim"]
        _pending["tool"] = None
        _pending["claim"] = None
        return t, c

    # ── Tools ─────────────────────────────────────────────────────────────────

    async def recall_case(params: FunctionCallParams) -> None:
        """Return the current case brief and recent transcript summary."""
        _pending["tool"] = "recall"
        brief = state.case_brief or "(no case brief loaded yet)"
        recent = state.running_transcript[-10:] if state.running_transcript else []
        summary_lines = [f"[{e['role']}] {e['text']}" for e in recent]
        await _broadcast_decision("(recall_case fired)", "recall")
        await params.result_callback({"case_brief": brief, "recent_transcript": summary_lines})

    async def search_legal(params: FunctionCallParams, query: str) -> None:
        """Search for statutes, case law, and legal precedents using web search.

        Args:
            query: Legal search query, e.g. 'Miranda rights requirements' or
                   'hearsay exception Federal Rules of Evidence 803'
        """
        _pending["tool"] = "search"
        await _broadcast_decision(f"Searching: {query}", "search")
        try:
            resp = await _openai.responses.create(
                model="gpt-4.1",
                tools=[{"type": "web_search_preview"}],
                input=f"Legal research query: {query}. Provide a concise answer with the most relevant statute or case citation.",
            )
            text = ""
            for block in resp.output:
                if hasattr(block, "content"):
                    for c in block.content:
                        if hasattr(c, "text"):
                            text += c.text
            if not text:
                text = str(resp.output)
        except Exception as e:
            logger.error(f"search_legal error: {e}")
            text = f"Search unavailable: {e}"
        await params.result_callback({"result": text[:800]})

    async def check_camera(params: FunctionCallParams) -> None:
        """Return the latest body-language and demeanor analysis from the camera."""
        _pending["tool"] = "camera"
        analysis = state.latest_vision_result or "(no camera analysis yet)"
        emotion = state.latest_emotion
        confidence = state.latest_emotion_confidence
        detail = f"{emotion} ({confidence}%)" if emotion else ""
        await _broadcast_decision("(check_camera fired)", "camera")
        await params.result_callback({"analysis": analysis, "emotion_detail": detail})

    async def fact_check(params: FunctionCallParams, claim: str) -> None:
        """Verify a specific factual claim made during testimony using web search.

        Use this immediately whenever anyone states a verifiable real-world fact:
        business hours, store locations, distances, travel times, dates, prices,
        operating hours, or alibi details. Do not wait — check it right away.

        Args:
            claim: The exact claim to verify, e.g.
                   "Macy's was open at 1am" or
                   "drive from downtown LA to Burbank takes 20 minutes at midnight"
        """
        _pending["tool"] = "fact_check"
        _pending["claim"] = claim
        await _broadcast_decision(f"Fact-checking: {claim}", "fact_check", claim=claim)
        try:
            resp = await _openai.responses.create(
                model="gpt-4.1",
                tools=[{"type": "web_search_preview"}],
                input=(
                    f'Fact-check this claim for use in a courtroom right now: "{claim}"\n\n'
                    "Search for verifiable information and return:\n"
                    "1. TRUE, FALSE, or UNVERIFIABLE\n"
                    "2. The key evidence in one sentence\n"
                    "3. A one-sentence verdict the lawyer can use immediately\n\n"
                    "Be direct. If false, say exactly why."
                ),
            )
            text = ""
            for block in resp.output:
                if hasattr(block, "content"):
                    for c in block.content:
                        if hasattr(c, "text"):
                            text += c.text
            if not text:
                text = str(resp.output)
        except Exception as e:
            logger.error(f"fact_check error: {e}")
            text = f"Fact-check unavailable: {e}"
        await params.result_callback({"verdict": text[:600], "claim": claim})

    tool_functions = [recall_case, search_legal, check_camera, fact_check]
    tools = ToolsSchema(standard_tools=tool_functions)

    # ── Pipeline components ───────────────────────────────────────────────────

    stt = NVidiaWebSocketSTTService(
        url=os.getenv("NVIDIA_ASR_URL", "ws://44.241.251.184:8080"),
        strip_interim_prefix=True,
    )

    enable_thinking = os.getenv("NEMOTRON_ENABLE_THINKING", "false").lower() == "true"
    llm = VLLMOpenAILLMService(
        api_key=os.getenv("NEMOTRON_LLM_API_KEY", "EMPTY"),
        base_url=os.getenv(
            "NEMOTRON_LLM_URL",
            "http://nemotron-fleet-alb-1322439314.us-west-2.elb.amazonaws.com/v1",
        ),
        settings=VLLMOpenAILLMService.Settings(
            model=os.getenv("NEMOTRON_LLM_MODEL", "nvidia/nemotron-3-super"),
            system_instruction=SYSTEM_INSTRUCTION,
            extra={"extra_body": {"chat_template_kwargs": {"enable_thinking": enable_thinking}}},
        ),
    )

    tts = GradiumTTSService(
        api_key=os.environ["GRADIUM_API_KEY"],
        settings=GradiumTTSService.Settings(
            voice=os.getenv("GRADIUM_VOICE_ID", "_6Aslh2DxfmnRLmP"),
        ),
    )

    for fn in tool_functions:
        llm.register_direct_function(fn)

    context = LLMContext(tools=tools)
    user_aggregator, assistant_aggregator = LLMContextAggregatorPair(
        context,
        user_params=LLMUserAggregatorParams(
            vad_analyzer=SileroVADAnalyzer(),
            user_turn_strategies=FilterIncompleteUserTurnStrategies(),
        ),
    )

    # Silence monitor — fires a proactive question after 8 s without user speech
    _silence: dict  = {"last_speech": time.monotonic(), "fired": False, "last_agent_spoke": 0.0}
    _monitor: dict  = {"task": None}
    _speaking: dict = {"active": False, "buffer": []}

    async def _silence_monitor():
        while True:
            await asyncio.sleep(2)
            if _silence["fired"] or not state.case_brief:
                continue
            if time.monotonic() - _silence["last_speech"] < 15:
                continue
            if time.monotonic() - _silence["last_agent_spoke"] < 20:
                continue
            _silence["fired"] = True
            try:
                resp = await _openai.chat.completions.create(
                    model="gpt-4o-mini",
                    messages=[{
                        "role": "user",
                        "content": (
                            "Given this case brief, what is the single most damaging question "
                            "the lawyer should ask right now? Return one short conversational "
                            "sentence starting with 'Ask [name]' or 'Bring up'. "
                            "Use the actual names from the brief. One sentence only.\n\n"
                            f"Brief:\n{state.case_brief[:2000]}"
                        ),
                    }],
                    max_tokens=60,
                )
                suggestion = resp.choices[0].message.content.strip()
                if suggestion:
                    context.add_message({
                        "role": "user",
                        "content": f"[Silence prompt] {suggestion}",
                    })
                    await worker.queue_frames([LLMRunFrame()])
            except Exception as e:
                logger.warning(f"Silence monitor error: {e}")

    # Broadcast complete user utterances when a turn ends; proactively claim-check
    @user_aggregator.event_handler("on_user_turn_started")
    async def on_user_turn_started(agg, *args):
        _turn_state["fact_checked"] = False

    @user_aggregator.event_handler("on_user_turn_stopped")
    async def on_user_turn_stopped(agg, strategy, message):
        text = message.content.strip()
        if not text:
            return
        _silence["last_speech"] = time.monotonic()
        _silence["fired"] = False
        asyncio.create_task(_broadcast_transcript("user", text))

        # While the agent is speaking, buffer new transcripts so we never
        # trigger a claim-monitor check (which could interrupt mid-sentence).
        if _speaking["active"]:
            _speaking["buffer"].append(text)
            return

        # Drain emotion alerts queued since the last turn into the LLM context
        while state.pending_emotion_alerts:
            alert = state.pending_emotion_alerts.pop(0)
            context.add_message({"role": "user", "content": alert})

        async def _claim_monitor():
            if _turn_state["fact_checked"]:
                return
            try:
                detect = await _openai.chat.completions.create(
                    model="gpt-4o-mini",
                    messages=[{
                        "role": "user",
                        "content": (
                            "Does this text contain a verifiable factual claim such as an alibi, "
                            "location, business hours, or specific time? Reply with JSON only: "
                            '{"contains_claim": true/false, "claim": "the exact claim or null"}'
                            f"\n\nText: {text}"
                        ),
                    }],
                    response_format={"type": "json_object"},
                    max_tokens=100,
                )
                data = json.loads(detect.choices[0].message.content)
                if not (data.get("contains_claim") and data.get("claim")):
                    return
                if _turn_state["fact_checked"]:
                    return
                _turn_state["fact_checked"] = True
                claim = data["claim"]

                # Emotion enrichment
                emotion_note = ""
                em = state.latest_emotion
                em_conf = state.latest_emotion_confidence
                if em and em.lower() in {"fear", "angry", "sad", "disgust"} and em_conf > 35:
                    emotion_note = f"\nNote: subject showing {em} ({em_conf}%) while making this claim."

                # Direct web search — no pipecat params, result goes to sidebar intel + context
                fc_resp = await _openai.responses.create(
                    model="gpt-4.1",
                    tools=[{"type": "web_search_preview"}],
                    input=(
                        f'Fact-check this claim for use in a courtroom right now: "{claim}"\n\n'
                        "Return: TRUE/FALSE/UNVERIFIABLE, key evidence in one sentence, "
                        "one-line verdict the lawyer can use immediately. Be direct."
                        + emotion_note
                    ),
                )
                fc_text = ""
                for block in fc_resp.output:
                    if hasattr(block, "content"):
                        for c in block.content:
                            if hasattr(c, "text"):
                                fc_text += c.text
                if not fc_text:
                    return
                verdict = _extract_verdict(fc_text)
                await _broadcast_decision(f"Fact-checking: {claim}", "fact_check",
                                          verdict=verdict, claim=claim)
                # Inject result silently so agent speaks the verdict, not the trigger
                context.add_message({
                    "role": "user",
                    "content": (
                        f'[Background fact-check] Claim: "{claim}"\n'
                        f"Result: {fc_text[:600]}{emotion_note}"
                    ),
                })
            except Exception as e:
                logger.warning(f"Claim monitor error: {e}")

        asyncio.create_task(_claim_monitor())

    # AgentResponseBroadcaster sits between LLM and TTS.
    # It waits for LLMFullResponseEndFrame before broadcasting — never partial text.
    agent_broadcaster = AgentResponseBroadcaster(get_pending_tool=get_pending_tool)

    pipeline = Pipeline(
        [
            transport.input(),
            stt,
            user_aggregator,
            llm,
            agent_broadcaster,   # buffers tokens; broadcasts full response on EndFrame
            tts,
            transport.output(),
            assistant_aggregator,
        ]
    )

    worker = PipelineWorker(
        pipeline,
        params=PipelineParams(
            enable_metrics=True,
            enable_usage_metrics=True,
            audio_in_sample_rate=16000,
            audio_out_sample_rate=24000,
        ),
    )

    # Expose live handles so HTTP routes (vision.py /evidence) can inject
    # messages into the running agent. Captured here, on the pipeline's loop.
    state.context = context
    state.worker = worker
    state.loop = asyncio.get_running_loop()

    @transport.event_handler("on_bot_started_speaking")
    async def on_bot_started_speaking(transport):
        _speaking["active"] = True
        state.agent_speaking = True

    @transport.event_handler("on_bot_stopped_speaking")
    async def on_bot_stopped_speaking(transport):
        _speaking["active"] = False
        state.agent_speaking = False
        _silence["last_agent_spoke"] = time.monotonic()
        _silence["fired"] = False
        # Replay any transcript that arrived while we were speaking
        if _speaking["buffer"]:
            buffered_text = " ".join(_speaking["buffer"])
            _speaking["buffer"].clear()
            # Dedup: if buffered text is identical or very similar to the last
            # agent utterance, the mic likely picked up the bot's own voice —
            # discard to prevent a repeated inference.
            last_agent = next(
                (e["text"] for e in reversed(state.running_transcript) if e.get("role") == "agent"),
                "",
            )
            buf_l, last_l = buffered_text.lower().strip(), last_agent.lower().strip()
            is_duplicate = (
                buf_l == last_l
                or (last_l and buf_l in last_l)
                or (buf_l and last_l in buf_l)
                or _word_similarity(buf_l, last_l) > 0.6
            )
            if not is_duplicate:
                context.add_message({"role": "user", "content": buffered_text})
                await worker.queue_frames([LLMRunFrame()])

    @transport.event_handler("on_client_connected")
    async def on_client_connected(transport, client):
        logger.info("Sidebar client connected")
        _silence["last_speech"] = time.monotonic()
        _silence["fired"] = False
        _monitor["task"] = asyncio.create_task(_silence_monitor())
        context.add_message({
            "role": "user",
            "content": (
                "Sidebar is now active and listening. "
                "Acknowledge in one short sentence that you are ready and monitoring."
            ),
        })
        await worker.queue_frames([LLMRunFrame()])

    @transport.event_handler("on_client_disconnected")
    async def on_client_disconnected(transport, client):
        logger.info("Sidebar client disconnected")
        if _monitor["task"]:
            _monitor["task"].cancel()
            _monitor["task"] = None
        state.context = None
        state.worker = None
        state.loop = None
        state.agent_speaking = False
        await worker.cancel()

    runner = WorkerRunner(handle_sigint=False)
    await runner.add_workers(worker)
    await runner.run()


async def bot(runner_args: RunnerArguments):
    from pipecat.runner.utils import create_transport

    # Daily is the transport Pipecat Cloud uses for browser sessions (dashboard +
    # client SDKs); SmallWebRTC is what `uv run bot-courtline.py` uses locally.
    # VAD lives on the user-turn aggregator (see run_bot), so the transport params
    # only need audio in/out. Camera output is disabled — this is an audio-only bot.
    transport_params = {
        "daily": lambda: DailyParams(
            audio_in_enabled=True,
            audio_out_enabled=True,
            camera_out_enabled=False,
        ),
        "webrtc": lambda: TransportParams(
            audio_in_enabled=True,
            audio_out_enabled=True,
        ),
    }

    transport = await create_transport(runner_args, transport_params)
    await run_bot(transport)


if __name__ == "__main__":
    from pipecat.runner.run import app, main
    from vision import router as vision_router

    app.include_router(vision_router)
    main()
