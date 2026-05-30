"""CourtLine Glass — voice AI legal co-pilot.

Stays silent. Speaks only when:
  1. It detects a factual or legal contradiction in what was said
  2. A statute or precedent lookup is needed
  3. The camera stress analysis flags elevated tension
  4. It is directly addressed by name ("CourtLine, ...")

Tools: recall_case(), search_legal(), check_camera()

Pipeline: Gradium STT → GPT-4.1 (OpenAI Responses API) → Gradium TTS
"""

import asyncio
import json
import os
from datetime import date

from dotenv import load_dotenv
from loguru import logger
from pipecat.adapters.schemas.tools_schema import ToolsSchema
from pipecat.audio.vad.silero import SileroVADAnalyzer
from pipecat.frames.frames import LLMRunFrame
from pipecat.pipeline.pipeline import Pipeline
from pipecat.pipeline.worker import PipelineParams, PipelineWorker
from pipecat.processors.aggregators.llm_context import LLMContext
from pipecat.processors.aggregators.llm_response_universal import (
    LLMContextAggregatorPair,
    LLMUserAggregatorParams,
)
from pipecat.runner.types import RunnerArguments, SmallWebRTCRunnerArguments
from pipecat.services.gradium.stt import GradiumSTTService
from pipecat.services.gradium.tts import GradiumTTSService
from pipecat.services.llm_service import FunctionCallParams
from pipecat.services.openai.responses.llm import OpenAIResponsesLLMService
from pipecat.transcriptions.language import Language
from pipecat.transports.base_transport import BaseTransport, TransportParams
from pipecat.transports.smallwebrtc.connection import SmallWebRTCConnection
from pipecat.transports.smallwebrtc.transport import SmallWebRTCTransport
from pipecat.turns.user_turn_strategies import FilterIncompleteUserTurnStrategies
from pipecat.workers.runner import WorkerRunner
from openai import AsyncOpenAI

from case_store import state

load_dotenv(override=True)

_openai = AsyncOpenAI(api_key=os.environ.get("OPENAI_API_KEY", ""))


async def _broadcast_decision(utterance: str, tool_fired: str | None):
    """Log to state and push to all decision WebSocket subscribers."""
    import json as _json
    d = state.add_decision(utterance, tool_fired)
    payload = _json.dumps({
        "type": "decision",
        "timestamp": d.timestamp,
        "utterance": utterance,
        "tool_fired": tool_fired,
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
    import json as _json
    entry = state.add_transcript(role, text)
    payload = _json.dumps({"type": "transcript", **entry})
    dead = []
    for ws in state.transcript_subscribers:
        try:
            await ws.send_text(payload)
        except Exception:
            dead.append(ws)
    for ws in dead:
        state.transcript_subscribers.remove(ws)



SYSTEM_INSTRUCTION = f"""You are CourtLine Glass, an autonomous AI legal intelligence operating as a lawyer's silent co-pilot during a live court proceeding. Today is {date.today().strftime('%A, %B %d, %Y')}.

OPERATING MODE: You are NOT a chatbot. You do not wait to be asked. You continuously monitor every word spoken and act the moment you detect something the lawyer needs to know.

INTERVENTION TRIGGERS — call the relevant tool and speak immediately:

1. LEGAL CLAIM HEARD → call search_legal()
   Any statute citation, constitutional argument, procedural rule, or legal standard → look it up and whisper the controlling law or case.
   Example: opposing counsel invokes Miranda → search "Miranda right to counsel custodial interrogation" → speak: "Statute: Miranda attaches at custodial interrogation, not formal charges. Brewer v. Williams (1977)."

2. VERIFIABLE FACT STATED → call fact_check()
   Any specific claim about: business hours, locations, distances, travel times, dates, prices, store hours, alibis → verify immediately.
   Example: witness says "I was at Macy's at 1am" → fact_check("Macy's store hours") → speak: "Fact check: Macy's closes at 9pm — that alibi is impossible, challenge it now."

3. CONTRADICTION WITH BRIEF → call recall_case()
   Anything said conflicts with the case brief → alert immediately.
   Example: speak: "Contradiction: brief places defendant in Seattle — witness just said New York."

4. DEMEANOR SHIFT → call check_camera() → report what you see in one sentence.

5. DIRECT QUESTION → lawyer says "CourtLine", "Glass", or "co-pilot" → answer directly.

MANDATORY RULE AFTER EVERY TOOL CALL — you must speak a verdict. Silence after a tool call is a failure.
- After fact_check: always speak the result. If FALSE: state what is wrong and say "challenge it now." If TRUE: confirm briefly. If UNVERIFIABLE: say "Could not verify — proceed with caution."
- After search_legal: always state the relevant statute or case in one sentence.
- After recall_case: state the contradiction or "No conflict found with the brief."
- After check_camera: always describe what you observe in one sentence.

RESPONSE FORMAT:
- Maximum 2 sentences. Hard limit.
- Lead with: "Statute:", "Fact check:", "Contradiction:", "Demeanor:", or answer directly.
- No preamble. No "I found that..." or "It appears..." — state the fact.

WHEN TO STAY SILENT: Between tool calls, when nothing actionable is detected. Never speak just to acknowledge. The lawyer's silence is your silence.
"""


async def run_bot(transport: BaseTransport):
    logger.info("CourtLine Glass bot starting")

    # ── Tool implementations ──────────────────────────────────────────────────

    async def recall_case(params: FunctionCallParams) -> None:
        """Return the current case brief and recent transcript summary."""
        brief = state.case_brief or "(no case brief loaded yet)"
        recent = state.running_transcript[-10:] if state.running_transcript else []
        summary_lines = [f"[{e['role']}] {e['text']}" for e in recent]
        result = {
            "case_brief": brief,
            "recent_transcript": summary_lines,
        }
        await _broadcast_decision("(recall_case fired)", "recall")
        await params.result_callback(result)

    async def search_legal(params: FunctionCallParams, query: str) -> None:
        """Search for statutes, case law, and legal precedents using web search.

        Args:
            query: Legal search query, e.g. 'Miranda rights requirements' or
                   'hearsay exception Federal Rules of Evidence 803'
        """
        await _broadcast_decision(f"Searching: {query}", "search")
        try:
            resp = await _openai.responses.create(
                model="gpt-4.1",
                tools=[{"type": "web_search_preview"}],
                input=f"Legal research query: {query}. Provide a concise answer with the most relevant statute or case citation.",
            )
            # Extract text from response
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
        analysis = state.latest_vision_result or "(no camera analysis yet — photo not captured)"
        await _broadcast_decision("(check_camera fired)", "camera")
        await params.result_callback({"analysis": analysis})

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
        await _broadcast_decision(f"Fact-checking: {claim}", "fact_check")
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

    stt = GradiumSTTService(
        api_key=os.environ["GRADIUM_API_KEY"],
        settings=GradiumSTTService.Settings(language=Language.EN),
    )

    llm = OpenAIResponsesLLMService(
        api_key=os.environ["OPENAI_API_KEY"],
        settings=OpenAIResponsesLLMService.Settings(
            model=os.getenv("OPENAI_MODEL", "gpt-4.1"),
            system_instruction=SYSTEM_INSTRUCTION,
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

    # ── Transcript broadcasting via aggregator turn events ────────────────────
    # on_user_turn_stopped fires with the complete finalized user utterance.
    # on_assistant_turn_stopped fires with the complete agent response.
    # Both are safe: they fire after the pipeline has fully processed the turn,
    # avoiding any StartFrame-ordering issues with FrameProcessor placement.

    @user_aggregator.event_handler("on_user_turn_stopped")
    async def on_user_turn_stopped(agg, strategy, message):
        if message.content.strip():
            asyncio.create_task(_broadcast_transcript("user", message.content.strip()))

    @assistant_aggregator.event_handler("on_assistant_turn_stopped")
    async def on_assistant_turn_stopped(agg, message):
        text = message.content.strip()
        if text and not message.interrupted:
            asyncio.create_task(_broadcast_transcript("agent", text))
            asyncio.create_task(_broadcast_decision(text, None))

    pipeline = Pipeline(
        [
            transport.input(),
            stt,
            user_aggregator,
            llm,
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
        logger.info("CourtLine client connected")
        context.add_message(
            {
                "role": "user",
                "content": (
                    "CourtLine Glass is now active and listening. "
                    "Acknowledge in one short sentence that you are ready and monitoring."
                ),
            }
        )
        await worker.queue_frames([LLMRunFrame()])

    @transport.event_handler("on_client_disconnected")
    async def on_client_disconnected(transport, client):
        logger.info("CourtLine client disconnected")
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
