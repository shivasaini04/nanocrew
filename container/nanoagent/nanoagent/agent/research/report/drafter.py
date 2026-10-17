import logging
from typing import List, Dict, Any
from nanoagent.providers.base import LLMProvider
from .types import PaperOutline, OutlineSection, PaperDraft, DraftSection

class SectionDrafter:
    """
    Writes academic paper sections based on a structured outline.
    """
    def __init__(self, provider: LLMProvider, model: str):
        self.provider = provider
        self.model = model
        self.logger = logging.getLogger(__name__)

    async def draft_section(self, section: OutlineSection, context: Dict[str, Any]) -> DraftSection:
        """
        Drafts a single academic section.
        """
        self.logger.info(f"Drafting section: {section.heading}")
        prompt = self._build_section_prompt(section, context)
        
        response = await self.provider.chat(
            messages=[
                {"role": "system", "content": self._get_system_prompt()},
                {"role": "user", "content": prompt}
            ],
            model=self.model,
            temperature=0.3
        )
        
        content = self._clean_content(response.content or "")
        return DraftSection(
            heading=section.heading,
            content=content,
            word_count=len(content.split())
        )

    async def draft_full_paper(self, outline: PaperOutline, research_context: Dict[str, Any]) -> PaperDraft:
        """
        Drafts the entire paper section by section.
        """
        self.logger.info(f"Starting full paper draft: {outline.title}")
        sections = []
        for outline_section in outline.sections:
            drafted = await self.draft_section(outline_section, research_context)
            sections.append(drafted)
            
        return PaperDraft(
            title=outline.title,
            abstract=outline.abstract_draft, # Initially use the one from outline
            sections=sections
        )

    def _get_system_prompt(self) -> str:
        return (
            "You are a professional academic writer for high-impact scientific journals. "
            "Write in a rigorous, formal, and objective academic tone. "
            "Avoid AI-meta-commentary, disclaimers, or flowery language. "
            "Integrate the provided citations naturally using standard (Author, Year) or [Number] format. "
            "Ensure the drafting adheres strictly to the provided key points."
        )

    def _build_section_prompt(self, section: OutlineSection, context: Dict[str, Any]) -> str:
        return (
            f"Please draft the following section of a research paper:\n\n"
            f"Section Heading: {section.heading}\n"
            f"Key Points to cover:\n" + "\n".join([f"- {p}" for p in section.key_points]) + "\n\n"
            f"Assigned Citations: {section.assigned_citations}\n"
            f"Word Count Target: {section.word_target} words.\n\n"
            f"Contextual Evidence/Results: {context.get('evidence_summary', 'Use provided key points.')}\n\n"
            "Write the full prose for this section only."
        )

    def _clean_content(self, text: str) -> str:
        # Remove common AI prefixes/suffixes
        text = text.strip()
        if text.startswith("Certainly") or text.startswith("Here is"):
            lines = text.split("\n")
            if len(lines) > 1:
                text = "\n".join(lines[1:]).strip()
        return text
