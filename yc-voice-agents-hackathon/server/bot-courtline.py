"""Sidebar — autonomous AI legal co-pilot.

Pipeline: NVIDIA ASR STT → Nemotron-3-Super LLM → Gradium TTS
Tools: recall_case, search_legal, check_camera, fact_check
"""

import asyncio
import json
import os
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

        elif isinstance(frame, LLMTextFrame) and frame.text:
            self._buf.append(frame.text)

        elif isinstance(frame, LLMFullResponseEndFrame):
            text = "".join(self._buf).strip()
            self._buf = []
            if not text:
                return
            tool, claim = self._get_pending_tool()
            verdict = _extract_verdict(text) if tool == "fact_check" else None
            asyncio.create_task(_broadcast_transcript("agent", text))
            asyncio.create_task(_broadcast_decision(text, tool, verdict=verdict, claim=claim))


# ── System instruction ────────────────────────────────────────────────────────

SYSTEM_INSTRUCTION = f"""You are Sidebar, an autonomous AI legal intelligence operating as a lawyer's silent co-pilot during a live court proceeding. Today is {date.today().strftime('%A, %B %d, %Y')}.

CRITICAL FRAMING — you are whispering ONLY to the lawyer, never to anyone in the courtroom:
- Always frame responses as private advice TO the lawyer, never as statements to the defendant, witness, or judge
- Say "Challenge the alibi" not "Your alibi is wrong"
- Say "Macy's closes at 9pm — press him on this" not "You couldn't have been at Macy's"
- Say "Object — this is hearsay under FRE 802" not "That is hearsay"
- Say "His timeline contradicts the brief — push back" not "Your timeline is inconsistent"
- You are not a participant in the proceedings. You are the lawyer's private intelligence feed.

OPERATING MODE: You are NOT a chatbot. You do not wait to be asked. You continuously monitor every word spoken and act the moment you detect something the lawyer needs to know.

INTERVENTION TRIGGERS — call the relevant tool and speak immediately:

1. LEGAL CLAIM HEARD → call search_legal()
   Any statute citation, constitutional argument, procedural rule, or legal standard → look it up.
   Example: opposing counsel invokes Miranda → speak: "Statute: Miranda attaches at custodial interrogation — cite Brewer v. Williams if they push back."

2. VERIFIABLE FACT STATED → call fact_check()
   Any specific claim: business hours, locations, distances, travel times, dates, store hours, alibis → verify immediately.
   Example: witness says "I was at Macy's at 1am" → speak: "Macy's closes at 9pm — that alibi is impossible, press him on it now."

3. CONTRADICTION WITH BRIEF → call recall_case()
   Anything said conflicts with the case brief → alert immediately.
   Example: speak: "Contradiction: brief places him in Seattle that day — challenge this."

4. DEMEANOR SHIFT → call check_camera()
   ALWAYS speak the demeanor result aloud to the lawyer. Do not stay silent after this tool.
   Example: speak: "Demeanor: elevated tension, evasive eye contact — watch for deception here."

5. DIRECT QUESTION → lawyer says "Sidebar" or "co-pilot" → answer directly.

MANDATORY RULE AFTER EVERY TOOL CALL — always speak a verdict. Silence after a tool call is a failure.
- After fact_check: speak the result as lawyer-directed advice. If FALSE: "X is wrong — challenge it now." If UNVERIFIABLE: "Can't confirm — proceed with caution."
- After search_legal: state the relevant statute or case as advice: "Cite X, it supports your position."
- After recall_case: state the contradiction as advice, or "No conflict with the brief."
- After check_camera: ALWAYS verbalize the demeanor observation. Never skip this.

RESPONSE FORMAT:
- Maximum 2 sentences. Hard limit.
- Lead with the type: "Statute:", "Fact check:", "Contradiction:", "Demeanor:", or answer directly.
- No preamble. No "I found that..." or "It appears..." — state the finding as actionable advice.

WHEN TO STAY SILENT: When nothing actionable is detected between triggers. Never speak to acknowledge. The lawyer's silence is your silence.
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

    # Broadcast complete user utterances when a turn ends
    @user_aggregator.event_handler("on_user_turn_stopped")
    async def on_user_turn_stopped(agg, strategy, message):
        if message.content.strip():
            asyncio.create_task(_broadcast_transcript("user", message.content.strip()))

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

    @transport.event_handler("on_client_connected")
    async def on_client_connected(transport, client):
        logger.info("Sidebar client connected")
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
        await worker.cancel()

    runner = WorkerRunner(handle_sigint=False)
    await runner.add_workers(worker)
    await runner.run()


async def bot(runner_args: RunnerArguments):
    match runner_args:
        case SmallWebRTCRunnerArguments():
            transport = SmallWebRTCTransport(
                webrtc_connection=runner_args.webrtc_connection,
                params=TransportParams(
                    audio_in_enabled=True,
                    audio_out_enabled=True,
                ),
            )
        case _:
            logger.error(f"Unsupported runner args: {type(runner_args)}")
            return

    await run_bot(transport)


if __name__ == "__main__":
    from pipecat.runner.run import app, main
    from vision import router as vision_router

    app.include_router(vision_router)
    main()
