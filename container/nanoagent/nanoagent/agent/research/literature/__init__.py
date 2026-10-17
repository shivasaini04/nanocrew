from .arxiv import ArxivClient, PaperMetadata
from .cache import LiteratureCache
from .citation_gate import (
    CitationVerificationResult,
    filter_hallucinated_citations,
    verify_citation,
)
from .extractor import KnowledgeCard, KnowledgeExtractor, SynthesisReport
from .semantic_scholar import SemanticScholarClient
from .strategy import SearchStrategy
from .verifier import CitationVerifier, VerificationResult

__all__ = [
    "ArxivClient",
    "PaperMetadata",
    "SemanticScholarClient",
    "SearchStrategy",
    "KnowledgeExtractor",
    "KnowledgeCard",
    "SynthesisReport",
    "CitationVerifier",
    "VerificationResult",
    "LiteratureCache",
    "CitationVerificationResult",
    "verify_citation",
    "filter_hallucinated_citations",
]
