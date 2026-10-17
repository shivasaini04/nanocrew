"""Tool for searching the system's long-term knowledge base."""

import asyncio
import json
import time
from pathlib import Path
from typing import Any, Dict, List, Optional
from nanoagent.agent.tools.base import Tool

class SearchKnowledgeTool(Tool):
    """
    Search the system's long-term memory for relevant lessons, patterns, or bug fixes.
    This tool uses file-based IPC to communicate with the NanoCrew SearchService.
    """
    
    def __init__(self, **data):
        super().__init__(**data)
        self._ipc_dir = Path("/workspace/ipc")
        self._req_dir = self._ipc_dir / "search_requests"
        self._res_dir = self._ipc_dir / "search_responses"

    @property
    def name(self) -> str:
        return "search_knowledge"

    @property
    def description(self) -> str:
        return (
            "Search the system's long-term memory for relevant past expertise. "
            "Returns a list of Knowledge Items including titles, scores, and content snippets. "
            "Use this when you encounter a problem you think might have been solved before, "
            "or when starting a task that requires specific patterns or lessons."
        )

    @property
    def parameters(self) -> dict[str, Any]:
        return {
            "type": "object",
            "properties": {
                "query": {
                    "type": "string",
                    "description": "The search query (keywords related to the problem or task)",
                },
                "limit": {
                    "type": "integer",
                    "description": "Maximum number of results to return (default: 3)",
                    "default": 3
                },
            },
            "required": ["query"],
        }

    async def execute(self, query: str, limit: int = 3, **kwargs: Any) -> str:
        try:
            self._req_dir.mkdir(parents=True, exist_ok=True)
            self._res_dir.mkdir(parents=True, exist_ok=True)
            
            timestamp = int(time.time() * 1000)
            req_filename = f"req_{timestamp}.json"
            res_filename = f"res_{timestamp}.json"
            
            req_path = self._req_dir / req_filename
            res_path = self._res_dir / res_filename
            
            # Write request
            payload = {
                "query": query,
                "limit": limit
            }
            
            with open(req_path, "w", encoding="utf-8") as f:
                json.dump(payload, f)
            
            # Poll for response
            max_attempts = 20
            for _ in range(max_attempts):
                if res_path.exists():
                    try:
                        with open(res_path, "r", encoding="utf-8") as f:
                            results = json.load(f)
                        # Cleanup response file
                        res_path.unlink()
                        
                        if not results:
                            return f"No relevant architecture or lessons found for: '{query}'"
                            
                        # Format results for the LLM
                        formatted = f"Found {len(results)} relevant Knowledge Item(s):\n\n"
                        for i, r in enumerate(results, 1):
                            formatted += f"{i}. {r['title']} (Type: {r['type'].upper()}, Score: {r['score']})\n"
                            formatted += f"   Snippet: {r['content']}\n\n"
                            
                        return formatted
                    except Exception as e:
                        return f"Error reading search results: {str(e)}"
                
                await asyncio.sleep(0.5)
                
            return "Search request timed out. The system took too long to respond."
            
        except Exception as e:
            return f"Error executing knowledge search: {str(e)}"
