"""Unit tests for Literature Engine & Anti-Hallucination Citation Gate."""

import xml.etree.ElementTree as ET
import pytest

from nanoagent.agent.research.literature.arxiv import ArxivClient, PaperMetadata
from nanoagent.agent.research.literature.citation_gate import (
    filter_hallucinated_citations,
    verify_citation,
)


def test_verify_citation_grounded_claim():
    source_text = (
        "We introduce Transformer-XL, a novel architecture that enables learning "
        "dependency beyond a fixed length without disrupting temporal coherence. "
        "It achieves an 80% improvement on long-term modeling benchmarks."
    )
    grounded_claim = "Transformer-XL enables learning dependencies beyond fixed length with 80% benchmark gains."

    res = verify_citation(grounded_claim, source_text, source_id="arxiv:1901.02860")
    assert res.is_valid is True
    assert res.confidence >= 0.35
    assert "Transformer-XL" in res.matched_passage


def test_verify_citation_hallucinated_claim():
    source_text = (
        "We introduce Transformer-XL, a novel architecture that enables learning "
        "dependency beyond a fixed length without disrupting temporal coherence."
    )
    hallucinated_claim = "The system implements quantum cryptographic key distribution using topological qubits."

    res = verify_citation(hallucinated_claim, source_text, source_id="arxiv:1901.02860")
    assert res.is_valid is False
    assert res.confidence < 0.2


def test_filter_hallucinated_citations():
    sources = {
        "p1": "Deep reinforcement learning achieves superhuman performance in chess and shogi.",
        "p2": "CRISPR-Cas9 enables high-precision genomic editing in mammalian cells.",
    }

    citations = [
        {"claim": "Reinforcement learning masters chess with superhuman performance.", "source_id": "p1"},
        {"claim": "CRISPR edits genomes in mammalian cellular structures.", "source_id": "p2"},
        {"claim": "Nuclear fusion reactors reached sustained net power output at room temperature.", "source_id": "p1"},
    ]

    verified, unverified = filter_hallucinated_citations(citations, sources, threshold=0.3)
    assert len(verified) == 2
    assert len(unverified) == 1
    assert unverified[0]["source_id"] == "p1"
    assert "Nuclear fusion" in unverified[0]["claim"]


def test_arxiv_xml_entry_parsing():
    client = ArxivClient()
    xml_data = """
    <entry xmlns="http://www.w3.org/2005/Atom">
        <id>http://arxiv.org/abs/2301.00001v1</id>
        <title>Attention Is All You Need</title>
        <summary>The dominant sequence transduction models are based on complex recurrent or convolutional neural networks.</summary>
        <published>2023-01-01T00:00:00Z</published>
        <author><name>Ashish Vaswani</name></author>
        <category term="cs.CL"/>
        <link rel="related" type="application/pdf" href="http://arxiv.org/pdf/2301.00001v1"/>
    </entry>
    """
    entry = ET.fromstring(xml_data)
    paper = client._parse_entry(entry)

    assert paper.arxiv_id == "2301.00001v1"
    assert paper.title == "Attention Is All You Need"
    assert paper.authors == ["Ashish Vaswani"]
    assert "convolutional neural networks" in paper.abstract
    assert paper.pdf_url == "http://arxiv.org/pdf/2301.00001v1"
