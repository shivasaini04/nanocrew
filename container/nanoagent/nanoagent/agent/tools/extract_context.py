"""Tool for extracting and summarizing conversation context and entities."""

import json
from typing import Any, Dict, List, Optional
from nanoagent.agent.tools.base import Tool

class ExtractContextTool(Tool):
    """
    Analyze the current conversation history to extract key entities, 
    pending objectives, and technical constraints.
    Returns a structured context brief for sharing with swarm workers.
    """
    
    @property
    def name(self) -> str:
        return "summarize_conversation_context"
    
    @property
    def description(self) -> str:
        return (
            "Analyze conversation history to extract key entities, objectives, and constraints. "
            "Use this to create a 'Context Brief' for swarm workers to ensure alignment."
        )
    
    @property
    def parameters(self) -> dict[str, Any]:
        return {
            "type": "object",
            "properties": {},
            "required": []
        }
    
    async def execute(self, history: Optional[List[Dict[str, Any]]] = None, **kwargs: Any) -> str:
        if not history:
            return "No conversation history provided to extract context from."
            
        entities: List[str] = []
        objectives: List[str] = []
        constraints: List[str] = []
        
        for msg in history:
            content = msg.get("content")
            if not content or not isinstance(content, str):
                continue
                
            lines = content.split('\n')
            for line in lines:
                line = line.strip()
                if line.startswith("- ") or line.startswith("* "):
                    clean_line = line[2:].strip()
                    if "must" in clean_line.lower() or "should" in clean_line.lower():
                        constraints.append(clean_line)
                    else:
                        objectives.append(clean_line)
        
        # Deduplicate and limit
        unique_objectives = list(dict.fromkeys(objectives))
        unique_constraints = list(dict.fromkeys(constraints))
        
        brief = {
            "summary": "Current Conversation Context Brief",
            "entities": list(dict.fromkeys(entities)),
            "objectives": unique_objectives[-5:] if len(unique_objectives) > 5 else unique_objectives,
            "constraints": unique_constraints[-3:] if len(unique_constraints) > 3 else unique_constraints,
            "raw_history_length": len(history)
        }
        
        return json.dumps(brief, indent=2)
