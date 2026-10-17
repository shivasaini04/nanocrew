import asyncio
import time
import logging
import urllib.request
import urllib.parse
import ssl
import xml.etree.ElementTree as ET
from dataclasses import dataclass
from typing import List, Optional
from datetime import datetime

@dataclass
class PaperMetadata:
    arxiv_id: str
    title: str
    authors: List[str]
    abstract: str
    published_date: str
    categories: List[str]
    pdf_url: str

class ArxivClient:
    """
    Client for querying the arXiv API (http://export.arxiv.org/api/query).
    Implements rate limiting and metadata parsing.
    """
    ARXIV_API_URL = "http://export.arxiv.org/api/query"
    RATE_LIMIT_DELAY = 5.0  # Increased to 5s for safety
    MAX_RETRIES = 3

    def __init__(self):
        self.last_call_time = 0.0
        self.logger = logging.getLogger(__name__)

    async def _throttle(self):
        """Ensures at least 3 seconds between API calls."""
        elapsed = time.time() - self.last_call_time
        if elapsed < self.RATE_LIMIT_DELAY:
            wait_time = self.RATE_LIMIT_DELAY - elapsed
            self.logger.debug(f"Throttling arXiv request for {wait_time:.2f}s")
            await asyncio.sleep(wait_time)
        self.last_call_time = time.time()

    def _parse_entry(self, entry: ET.Element) -> PaperMetadata:
        """Parses an <entry> XML element from arXiv into PaperMetadata."""
        ns = {'atom': 'http://www.w3.org/2005/Atom'}
        
        # ID is usually http://arxiv.org/abs/1234.5678v1
        id_url = entry.find('atom:id', ns).text
        arxiv_id = id_url.split('/abs/')[-1]
        
        title = entry.find('atom:title', ns).text.replace('\n', ' ').strip()
        abstract = entry.find('atom:summary', ns).text.replace('\n', ' ').strip()
        published = entry.find('atom:published', ns).text
        
        authors = [a.find('atom:name', ns).text for a in entry.findall('atom:author', ns)]
        categories = [c.attrib['term'] for c in entry.findall('atom:category', ns)]
        
        pdf_url = ""
        for link in entry.findall('atom:link', ns):
            if link.attrib.get('title') == 'pdf':
                pdf_url = link.attrib['href']
            elif link.attrib.get('type') == 'application/pdf':
                pdf_url = link.attrib['href']

        return PaperMetadata(
            arxiv_id=arxiv_id,
            title=title,
            authors=authors,
            abstract=abstract,
            published_date=published,
            categories=categories,
            pdf_url=pdf_url
        )

    async def search(self, query: str, max_results: int = 5) -> List[PaperMetadata]:
        """
        Searches arXiv for papers matching the given query string.
        """
        await self._throttle()
        
        # Construct the URL
        params = f"search_query=all:{urllib.parse.quote(query)}&start=0&max_results={max_results}"
        url = f"{self.ARXIV_API_URL}?{params}"
        
        self.logger.info(f"Querying arXiv: {url}")
        
        context = ssl._create_unverified_context()
        for attempt in range(self.MAX_RETRIES):
            try:
                with urllib.request.urlopen(url, context=context) as response:
                    content = response.read().decode('utf-8')
                    root = ET.fromstring(content)
                    
                    ns = {'atom': 'http://www.w3.org/2005/Atom'}
                    entries = root.findall('atom:entry', ns)
                    
                    return [self._parse_entry(entry) for entry in entries]
            except urllib.error.HTTPError as e:
                if e.code == 429:
                    wait_time = (attempt + 1) * 10
                    self.logger.warning(f"arXiv rate limit hit (429). Retrying in {wait_time}s...")
                    await asyncio.sleep(wait_time)
                else:
                    self.logger.error(f"arXiv HTTP error: {e}")
                    break
            except Exception as e:
                self.logger.error(f"arXiv search failed: {e}")
                break
        return []

    async def get_paper(self, arxiv_id: str) -> Optional[PaperMetadata]:
        """
        Retrieves metadata for a single paper by its arXiv ID.
        """
        # IDs can be e.g. 2301.01234 or v2
        await self._throttle()
        
        params = f"id_list={arxiv_id}"
        url = f"{self.ARXIV_API_URL}?{params}"
        
        context = ssl._create_unverified_context()
        try:
            with urllib.request.urlopen(url, context=context) as response:
                content = response.read().decode('utf-8')
                root = ET.fromstring(content)
                ns = {'atom': 'http://www.w3.org/2005/Atom'}
                entry = root.find('atom:entry', ns)
                if entry is not None:
                    return self._parse_entry(entry)
        except Exception as e:
            self.logger.error(f"arXiv get_paper failed: {e}")
            
        return None

    async def validate_id(self, arxiv_id: str) -> bool:
        """
        Returns True if the arXiv ID exists and is valid.
        """
        paper = await self.get_paper(arxiv_id)
        return paper is not None
