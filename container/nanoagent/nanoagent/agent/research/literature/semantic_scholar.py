import asyncio
import time
import logging
import urllib.request
import urllib.parse
import json
import ssl
from typing import List, Optional, Dict, Any
from .arxiv import PaperMetadata

class SemanticScholarClient:
    """
    Client for querying the Semantic Scholar API (https://api.semanticscholar.org/graph/v1).
    Public tier allows ~1 request per second.
    """
    BASE_URL = "https://api.semanticscholar.org/graph/v1"
    RATE_LIMIT_DELAY = 1.0  # seconds
    
    # Fields to retrieve from the API
    PAPER_FIELDS = "paperId,externalIds,title,authors,abstract,publicationDate,s2FieldsOfStudy,url,citationCount,influentialCitationCount"

    def __init__(self, api_key: Optional[str] = None):
        self.api_key = api_key
        self.last_call_time = 0.0
        self.logger = logging.getLogger(__name__)

    async def _throttle(self):
        """Ensures rate limiting is respected."""
        elapsed = time.time() - self.last_call_time
        delay = self.RATE_LIMIT_DELAY if not self.api_key else 0.1
        if elapsed < delay:
            await asyncio.sleep(delay - elapsed)
        self.last_call_time = time.time()

    def _map_to_metadata(self, data: Dict[str, Any]) -> PaperMetadata:
        """Maps Semantic Scholar API response to shared PaperMetadata structure."""
        external_ids = data.get('externalIds', {})
        arxiv_id = external_ids.get('ArXiv', '')
        
        authors = [a.get('name', '') for a in data.get('authors', [])]
        
        metadata = PaperMetadata(
            arxiv_id=arxiv_id,
            title=data.get('title', ''),
            authors=authors,
            abstract=data.get('abstract', '') or '',
            published_date=data.get('publicationDate', '') or '',
            categories=data.get('s2FieldsOfStudy', []) or [],
            pdf_url=data.get('url', '') # S2 usually provides a landing page URL
        )
        
        # Add S2-specific fields as extra attributes if needed
        metadata.s2_id = data.get('paperId')
        metadata.citation_count = data.get('citationCount', 0)
        metadata.influential_citation_count = data.get('influentialCitationCount', 0)
        metadata.doi = external_ids.get('DOI')
        
        return metadata

    async def _request(self, endpoint: str, params: Dict[str, str]) -> Optional[Dict[str, Any]]:
        """Internal helper for API requests."""
        await self._throttle()
        
        query_string = urllib.parse.urlencode(params)
        url = f"{self.BASE_URL}/{endpoint}?{query_string}"
        
        headers = {}
        if self.api_key:
            headers["x-api-key"] = self.api_key
            
        req = urllib.request.Request(url, headers=headers)
        context = ssl._create_unverified_context()
        
        try:
            with urllib.request.urlopen(req, context=context) as response:
                return json.loads(response.read().decode('utf-8'))
        except Exception as e:
            self.logger.error(f"Semantic Scholar request failed: {e}")
            return None

    async def search(self, query: str, limit: int = 10) -> List[PaperMetadata]:
        """Searches for papers and returns metadata."""
        params = {
            "query": query,
            "limit": str(limit),
            "fields": self.PAPER_FIELDS
        }
        
        data = await self._request("paper/search", params)
        if not data or 'data' not in data:
            return []
            
        return [self._map_to_metadata(item) for item in data['data']]

    async def get_citations(self, paper_id: str, limit: int = 50) -> List[PaperMetadata]:
        """Retrieves papers that cite the given paper."""
        params = {
            "fields": f"citingPaper({self.PAPER_FIELDS})",
            "limit": str(limit)
        }
        
        data = await self._request(f"paper/{paper_id}/citations", params)
        if not data or 'data' not in data:
            return []
            
        return [self._map_to_metadata(item['citingPaper']) for item in data['data'] if 'citingPaper' in item]

    async def get_references(self, paper_id: str, limit: int = 50) -> List[PaperMetadata]:
        """Retrieves papers cited by the given paper."""
        params = {
            "fields": f"citedPaper({self.PAPER_FIELDS})",
            "limit": str(limit)
        }
        
        data = await self._request(f"paper/{paper_id}/references", params)
        if not data or 'data' not in data:
            return []
            
        return [self._map_to_metadata(item['citedPaper']) for item in data['data'] if 'citedPaper' in item]

    async def match_title(self, title: str) -> Optional[PaperMetadata]:
        """Fuzzy matches a title to a real paper."""
        results = await self.search(title, limit=1)
        if results:
            # Basic verification: check if titles are reasonably similar
            # In production, we'd use Levenshtein distance
            if results[0].title.lower()[:30] in title.lower() or title.lower()[:30] in results[0].title.lower():
                return results[0]
        return None
