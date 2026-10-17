from dataclasses import dataclass, field
from typing import List, Optional

@dataclass
class OutlineSection:
    heading: str
    key_points: List[str] = field(default_factory=list)
    assigned_citations: List[str] = field(default_factory=list)
    word_target: int = 500

@dataclass
class PaperOutline:
    title: str
    abstract_draft: str
    sections: List[OutlineSection] = field(default_factory=list)

@dataclass
class DraftSection:
    heading: str
    content: str
    word_count: int

@dataclass
class PaperDraft:
    title: str
    abstract: str
    sections: List[DraftSection] = field(default_factory=list)
    version: str = "v1.0"

@dataclass
class RevisionRequest:
    section: str
    issue: str
    suggestion: str

@dataclass
class PeerReview:
    overall_score: float	# 1-10
    strengths: List[str]
    weaknesses: List[str]
    methodology_score: float
    evidence_score: float
    writing_score: float
    revision_requests: List[RevisionRequest] = field(default_factory=list)
    verdict: str = "minor_revision"	# accept, minor_revision, major_revision, reject
