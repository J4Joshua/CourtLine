"""Shared in-process state for CourtLine Glass / Sidebar.

All modules import from here. Thread-safe for asyncio (single-process).
"""

from dataclasses import dataclass, field
from datetime import datetime
from typing import Optional


@dataclass
class AgentDecision:
    timestamp: str
    utterance: str
    tool_fired: Optional[str]       # "recall" | "search" | "camera" | "fact_check" | None
    verdict: Optional[str] = None   # "TRUE" | "FALSE" | "UNVERIFIABLE" (fact_check only)
    claim: Optional[str] = None     # the original claim that was fact-checked


@dataclass
class CourtLineState:
    case_brief: str = ""
    running_transcript: list[dict] = field(default_factory=list)

    # Evidence submitted live during a session (OCR/description of exhibit images)
    evidence: list[dict] = field(default_factory=list)

    # Latest full GPT-4o analysis text
    latest_vision_result: str = ""
    # Raw FER emotion data — updated every auto-capture cycle
    latest_emotion: str = ""
    latest_emotion_confidence: int = 0
    latest_emotion_flagged: bool = False

    agent_decisions: list[AgentDecision] = field(default_factory=list)

    # WebSocket subscribers for live push
    transcript_subscribers: list = field(default_factory=list)
    decision_subscribers: list = field(default_factory=list)

    # Live pipeline handles — set by run_bot on connect, cleared on disconnect.
    # Allow HTTP routes (vision.py) to inject messages into the running agent.
    context: object = None          # pipecat LLMContext
    worker: object = None           # pipecat PipelineWorker
    loop: object = None             # the asyncio loop the pipeline runs on
    agent_speaking: bool = False    # True while the LLM is mid-response

    def add_transcript(self, role: str, text: str):
        entry = {"role": role, "text": text, "ts": datetime.utcnow().isoformat()}
        self.running_transcript.append(entry)
        return entry

    def add_evidence(self, summary: str, label: str = ""):
        entry = {"label": label, "summary": summary, "ts": datetime.utcnow().isoformat()}
        self.evidence.append(entry)
        return entry

    def add_decision(
        self,
        utterance: str,
        tool_fired: Optional[str],
        verdict: Optional[str] = None,
        claim: Optional[str] = None,
    ):
        d = AgentDecision(
            timestamp=datetime.utcnow().isoformat(),
            utterance=utterance,
            tool_fired=tool_fired,
            verdict=verdict,
            claim=claim,
        )
        self.agent_decisions.append(d)
        return d


# Singleton — import `state` everywhere
state = CourtLineState()
