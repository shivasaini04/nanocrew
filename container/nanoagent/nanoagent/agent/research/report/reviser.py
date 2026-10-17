import logging
from typing import List, Dict, Any
from nanoagent.providers.base import LLMProvider
from .types import PaperDraft, PeerReview, DraftSection, RevisionRequest

class RevisionEngine:
    """
    Automatically addresses peer review feedback to improve paper drafts.
    """
    def __init__(self, provider: LLMProvider, model: str):
        self.provider = provider
        self.model = model
        self.logger = logging.getLogger(__name__)

    async def revise(self, draft: PaperDraft, review: PeerReview) -> PaperDraft:
        """
        Produces a revised version of the paper draft.
        """
        self.logger.info(f"Revising paper: {draft.title} (Current version: {draft.version})")
        
        revised_sections = []
        
        # Map requests to sections
        requests_by_section = {}
        for request in review.revision_requests:
            if request.section not in requests_by_section:
                requests_by_section[request.section] = []
            requests_by_section[request.section].append(request)
            
        for section in draft.sections:
            if section.heading in requests_by_section:
                revised_section = await self._revise_section(section, requests_by_section[section.heading])
                revised_sections.append(revised_section)
            else:
                revised_sections.append(section)
                
        # Increment version
        new_version = self._increment_version(draft.version)
        
        return PaperDraft(
            title=draft.title,
            abstract=draft.abstract,
            sections=revised_sections,
            version=new_version
        )

    async def _revise_section(self, section: DraftSection, requests: List[RevisionRequest]) -> DraftSection:
        """
        Revises a single section based on specific feedback.
        """
        self.logger.info(f"Revising section: {section.heading}")
        prompt = self._build_revision_prompt(section, requests)
        
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

    def _get_system_prompt(self) -> str:
        return (
            "You are a senior academic reviser. Your goal is to improve research papers based on peer review feedback. "
            "Address every critique precisely while maintaining the original scientific integrity and formal academic tone. "
            "Do not add disclaimers or conversational filler."
        )

    def _build_revision_prompt(self, section: DraftSection, requests: List[RevisionRequest]) -> str:
        requests_str = "\n".join([f"- Issue: {r.issue}\n  Suggestion: {r.suggestion}" for r in requests])
        return (
            f"Please revise the following section of a research paper based on peer review feedback:\n\n"
            f"Section Heading: {section.heading}\n"
            f"Current Content:\n{section.content}\n\n"
            f"Revision Requests:\n{requests_str}\n\n"
            "Produce the full revised prose for this section only."
        )

    def _increment_version(self, version: str) -> str:
        try:
            prefix = version[0] if version[0].isalpha() else ""
            num_part = version[len(prefix):]
            major, minor = map(int, num_part.split('.'))
            return f"{prefix}{major}.{minor + 1}"
        except:
            return "v1.1"

    def _clean_content(self, text: str) -> str:
        text = text.strip()
        # Remove markdown headers if the LLM repeats them
        lines = text.split("\n")
        if lines and lines[0].startswith("#"):
            text = "\n".join(lines[1:]).strip()
        return text
