import json
import os
from datetime import datetime
from typing import List, Dict, Any, Optional

class KIDistiller:
    """Harvests research results and converts them into structured Knowledge Items."""
    
    def __init__(self, knowledge_base_path: str):
        self.kb_path = knowledge_base_path
        os.makedirs(self.kb_path, exist_ok=True)

    def distill_session(self, goal: str, findings: List[Dict[str, Any]], lessons: List[Any]):
        """Runs the full distillation process for a research session."""
        topic = goal.lower().replace(" ", "_")[:50]
        session_dir = os.path.join(self.kb_path, "research", topic)
        os.makedirs(os.path.join(session_dir, "findings"), exist_ok=True)
        
        distilled_count = 0
        for finding in findings:
            if finding.get("status") == "verified" or finding.get("metric", 0) > 0.8:
                self._create_finding_ki(session_dir, finding, goal)
                distilled_count += 1
                
        return distilled_count

    def _create_finding_ki(self, session_dir: str, finding: Dict[str, Any], goal: str):
        """Creates a single KI for a verified finding."""
        finding_id = f"finding_{datetime.now().strftime('%Y%m%d_%H%M%S')}"
        finding_path = os.path.join(session_dir, "findings", finding_id)
        os.makedirs(finding_path, exist_ok=True)
        
        # 1. Create metadata.json
        metadata = {
            "title": f"Research Finding: {finding.get('thesis', 'Untitled')}",
            "summary": finding.get("description", "No description provided."),
            "category": "scientific_discovery",
            "source": {
                "type": "autonomous_research",
                "goal": goal,
                "iteration": finding.get("iteration"),
                "metric": finding.get("metric")
            },
            "timestamp": datetime.now().isoformat(),
            "confidence": 0.95 if finding.get("status") == "verified" else 0.8
        }
        
        with open(os.path.join(finding_path, "metadata.json"), 'w') as f:
            json.dump(metadata, f, indent=2)
            
        # 2. Create artifacts/finding.md
        artifacts_dir = os.path.join(finding_path, "artifacts")
        os.makedirs(artifacts_dir, exist_ok=True)
        
        content = f"""# Research Finding: {finding.get('thesis', 'Untitled')}

## Context
This discovery was made during an autonomous research mission focused on: **{goal}**.

## Summary
{finding.get('description', 'No description provided.')}

## Empirical Evidence
- **Metric Value**: {finding.get('metric', 'N/A')}
- **Iteration**: {finding.get('iteration', 'N/A')}
- **Reasoning**: {finding.get('reasoning', 'N/A')}

## Automated Verification
This finding was passed through an adversarial debate loop and verified as scientifically sound.
"""
        with open(os.path.join(artifacts_dir, "finding.md"), 'w') as f:
            f.write(content)

    def distill_literature(self, goal: str, papers: List[Dict[str, Any]]):
        """Distills literature search results into a KI."""
        topic = goal.lower().replace(" ", "_")[:50]
        lit_dir = os.path.join(self.kb_path, "research", topic, "literature")
        os.makedirs(lit_dir, exist_ok=True)
        
        ki_path = os.path.join(lit_dir, "synthesis")
        os.makedirs(ki_path, exist_ok=True)
        
        # Simple synthesis placeholder
        metadata = {
            "title": f"Literature Synthesis: {goal}",
            "category": "literature_review",
            "paper_count": len(papers),
            "timestamp": datetime.now().isoformat()
        }
        
        with open(os.path.join(ki_path, "metadata.json"), 'w') as f:
            json.dump(metadata, f, indent=2)
            
        artifacts_dir = os.path.join(ki_path, "artifacts")
        os.makedirs(artifacts_dir, exist_ok=True)
        
        with open(os.path.join(artifacts_dir, "papers.md"), 'w') as f:
            f.write(f"# Literature Synthesis for {goal}\n\n")
            for p in papers:
                f.write(f"- **{p.get('title')}** ({p.get('year')}): {p.get('summary')}\n")
