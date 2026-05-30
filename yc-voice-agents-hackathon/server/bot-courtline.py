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
import queue as pyqueue
from datetime import date

from dotenv import load_dotenv
from loguru import logger
from pipecat.adapters.schemas.tools_schema import ToolsSchema
from pipecat.audio.vad.silero import SileroVADAnalyzer
from pipecat.frames.frames import InputAudioRawFrame, LLMRunFrame
from pipecat.pipeline.pipeline import Pipeline
from pipecat.pipeline.worker import PipelineParams, PipelineWorker
from pipecat.processors.aggregators.llm_context import LLMContext
from pipecat.processors.aggregators.llm_response_universal import (
    LLMContextAggregatorPair,
    LLMUserAggregatorParams,
)
from pipecat.runner.types import RunnerArguments, SmallWebRTCRunnerArguments
from pipecat.services.gradium.tts import GradiumTTSService
from pipecat.services.llm_service import FunctionCallParams

from nemotron_llm import VLLMOpenAILLMService
from nvidia_stt import NVidiaWebSocketSTTService
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


async def run_bot(transport: BaseTransport):
    logger.info("Sidebar bot starting")

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

    stt = NVidiaWebSocketSTTService(
        url=os.getenv("NVIDIA_ASR_URL", "ws://44.241.251.184:8080"),
        strip_interim_prefix=True,
    )

    enable_thinking = os.getenv("NEMOTRON_ENABLE_THINKING", "false").lower() == "true"
    llm = VLLMOpenAILLMService(
        api_key=os.getenv("NEMOTRON_LLM_API_KEY", "EMPTY"),
        base_url=os.getenv("NEMOTRON_LLM_URL", "http://nemotron-fleet-alb-1322439314.us-west-2.elb.amazonaws.com/v1"),
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

    # ── Mac-microphone audio input (optional) ─────────────────────────────────
    # When MAC_MIC_INPUT=1, capture THIS machine's microphone and feed it into
    # the pipeline as the user-audio source. This is the glasses use case: the
    # iOS app connects receive-only (WebRTC on iOS can't reliably capture the
    # Bluetooth-HFP glasses mic), so the agent listens via the Mac while it
    # speaks back over WebRTC to the glasses. No-op unless the flag is set, so
    # the normal browser/WebRTC audio-in path is unaffected. PortAudio delivers
    # blocks on its own thread; we hand them to the loop via a thread-safe queue.
    _mic_enabled = os.getenv("MAC_MIC_INPUT") == "1"
    _mic_queue: "pyqueue.Queue[bytes | None]" = pyqueue.Queue()
    _mic_stream = None
    _mic_task = None

    def _mic_callback(indata, frames, time_info, status):
        if status:
            logger.warning(f"[mac-mic] stream status: {status}")
        _mic_queue.put(bytes(indata))

    async def _mic_pump():
        loop = asyncio.get_event_loop()
        n = 0
        while True:
            data = await loop.run_in_executor(None, _mic_queue.get)
            if data is None:  # sentinel on disconnect
                break
            await worker.queue_frames(
                [InputAudioRawFrame(audio=data, sample_rate=16000, num_channels=1)]
            )
            n += 1
            if n == 1 or n % 100 == 0:
                logger.info(f"[mac-mic] fed {n} chunks into the pipeline")

    def _start_mic():
        nonlocal _mic_stream, _mic_task
        if not _mic_enabled or _mic_stream is not None:
            return
        try:
            import sounddevice as sd  # lazy: only needed when MAC_MIC_INPUT=1

            _mic_stream = sd.RawInputStream(
                samplerate=16000, channels=1, dtype="int16",
                blocksize=320, callback=_mic_callback,  # 20 ms @ 16 kHz
            )
            _mic_stream.start()
            _mic_task = asyncio.create_task(_mic_pump())
            logger.info("[mac-mic] capturing local microphone -> agent")
        except Exception as e:
            logger.error(f"[mac-mic] could not open microphone: {e}")

    def _stop_mic():
        nonlocal _mic_stream, _mic_task
        if _mic_stream is not None:
            _mic_stream.stop()
            _mic_stream.close()
            _mic_stream = None
        _mic_queue.put(None)  # unblock _mic_pump
        if _mic_task is not None:
            _mic_task.cancel()
            _mic_task = None

    @transport.event_handler("on_client_connected")
    async def on_client_connected(transport, client):
        logger.info("CourtLine client connected")
        _start_mic()
        context.add_message(
            {
                "role": "user",
                "content": (
                    "Sidebar is now active and listening. "
                    "Acknowledge in one short sentence that you are ready and monitoring."
                ),
            }
        )
        await worker.queue_frames([LLMRunFrame()])

    @transport.event_handler("on_client_disconnected")
    async def on_client_disconnected(transport, client):
        logger.info("CourtLine client disconnected")
        _stop_mic()
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
