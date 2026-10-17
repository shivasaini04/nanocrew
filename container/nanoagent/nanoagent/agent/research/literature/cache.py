import os
import json
import logging
import time
from typing import List, Optional, Dict, Any
from dataclasses import asdict
from .arxiv import PaperMetadata

class LiteratureCache:
    """
    Persistent local cache for academic paper metadata.
    Stores papers as JSON files in a dedicated directory.
    """
    def __init__(self, cache_dir: str):
        self.cache_dir = cache_dir
        self.logger = logging.getLogger(__name__)
        os.makedirs(self.cache_dir, exist_ok=True)

    def _get_path(self, paper_id: str) -> str:
        """Sanitizes paper ID to create a safe file path."""
        safe_id = paper_id.replace("/", "_").replace(":", "_")
        return os.path.join(self.cache_dir, f"{safe_id}.json")

    def get(self, paper_id: str) -> Optional[PaperMetadata]:
        """Retrieves a paper from the local cache."""
        path = self._get_path(paper_id)
        if not os.path.exists(path):
            return None
            
        try:
            with open(path, 'r', encoding='utf-8') as f:
                data = json.load(f)
                # s2 specific fields may be present
                metadata = PaperMetadata(
                    arxiv_id=data.get('arxiv_id'),
                    title=data.get('title'),
                    authors=data.get('authors'),
                    abstract=data.get('abstract'),
                    published_date=data.get('published_date'),
                    categories=data.get('categories'),
                    pdf_url=data.get('pdf_url')
                )
                # Re-attach optional fields if they exist
                for key in ['doi', 'citation_count', 'influential_citation_count', 's2_id']:
                    if key in data:
                        setattr(metadata, key, data[key])
                return metadata
        except Exception as e:
            self.logger.error(f"Failed to read cache for {paper_id}: {e}")
            return None

    def put(self, paper: PaperMetadata):
        """Saves or updates a paper in the local cache."""
        paper_id = paper.arxiv_id or getattr(paper, 's2_id', None) or paper.title
        if not paper_id:
            return
            
        path = self._get_path(paper_id)
        try:
            data = asdict(paper)
            # Ensure optional fields are included in the dict
            for key in ['doi', 'citation_count', 'influential_citation_count', 's2_id']:
                if hasattr(paper, key):
                    data[key] = getattr(paper, key)
                    
            with open(path, 'w', encoding='utf-8') as f:
                json.dump(data, f, indent=4)
        except Exception as e:
            self.logger.error(f"Failed to write cache for {paper_id}: {e}")

    def search_local(self, query: str) -> List[PaperMetadata]:
        """Performs a basic search through cached paper metadata."""
        results = []
        tokens = query.lower().split()
        
        try:
            for filename in os.listdir(self.cache_dir):
                if not filename.endswith(".json"):
                    continue
                    
                path = os.path.join(self.cache_dir, filename)
                with open(path, 'r', encoding='utf-8') as f:
                    data = json.load(f)
                    text = f"{data.get('title', '')} {data.get('abstract', '')}".lower()
                    
                    if all(t in text for t in tokens):
                        # Reconstruct metadata (same as get)
                        metadata = PaperMetadata(
                            arxiv_id=data.get('arxiv_id'),
                            title=data.get('title'),
                            authors=data.get('authors'),
                            abstract=data.get('abstract'),
                            published_date=data.get('published_date'),
                            categories=data.get('categories'),
                            pdf_url=data.get('pdf_url')
                        )
                        results.append(metadata)
        except Exception as e:
            self.logger.error(f"Local search failed: {e}")
            
        return results

    def clear_stale(self, ttl_days: int = 30):
        """Removes files older than ttl_days."""
        now = time.time()
        ttl_seconds = ttl_days * 86400
        
        try:
            for filename in os.listdir(self.cache_dir):
                path = os.path.join(self.cache_dir, filename)
                if os.path.isfile(path):
                    if now - os.path.getmtime(path) > ttl_seconds:
                        os.remove(path)
                        self.logger.info(f"Evicted stale cache file: {filename}")
        except Exception as e:
            self.logger.error(f"Cache eviction failed: {e}")
