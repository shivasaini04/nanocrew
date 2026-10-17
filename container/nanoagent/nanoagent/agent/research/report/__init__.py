"""Scientific Report, Memo & Publication Drafting subpackage for Research."""

from .drafter import SectionDrafter
from .exporter import ExportPipeline
from .outliner import OutlineGenerator
from .reviewer import PeerReviewer
from .reviser import RevisionEngine
from .types import (
    DraftSection,
    OutlineSection,
    PaperDraft,
    PaperOutline,
    PeerReview,
    RevisionRequest,
)

PaperOutliner = OutlineGenerator
DraftReviser = RevisionEngine

__all__ = [
    "SectionDrafter",
    "ExportPipeline",
    "OutlineGenerator",
    "PaperOutliner",
    "PeerReviewer",
    "RevisionEngine",
    "DraftReviser",
    "DraftSection",
    "OutlineSection",
    "PaperDraft",
    "PaperOutline",
    "PeerReview",
    "RevisionRequest",
]
