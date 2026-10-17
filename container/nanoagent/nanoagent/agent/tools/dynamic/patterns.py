import json
import re
from dataclasses import dataclass, field, asdict
from pathlib import Path
from typing import Dict, List, Optional, Any
from loguru import logger

@dataclass
class Pattern:
    tool_name: str
    description: str
    category: str
    implementation_skeleton: str
    libraries_used: List[str]
    success_count: int = 0
    failure_count: int = 0
    tags: List[str] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "Pattern":
        return cls(**data)


class PatternStore:
    """
    Learns and stores successful and failed tool patterns to improve future generation.
    """
    def __init__(self, patterns_file: Path):
        self.patterns_file = patterns_file
        self.patterns: Dict[str, Pattern] = {}
        self.load()

    def load(self):
        if self.patterns_file.exists():
            try:
                with open(self.patterns_file, "r", encoding="utf-8") as f:
                    data = json.load(f)
                    for k, v in data.items():
                        self.patterns[k] = Pattern.from_dict(v)
            except Exception as e:
                logger.error(f"Failed to load patterns: {e}")

    def save(self):
        try:
            self.patterns_file.parent.mkdir(parents=True, exist_ok=True)
            with open(self.patterns_file, "w", encoding="utf-8") as f:
                json.dump({k: v.to_dict() for k, v in self.patterns.items()}, f, indent=2)
        except Exception as e:
            logger.error(f"Failed to save patterns: {e}")

    def _skeletonize(self, code: str) -> str:
        """
        Removes string literals and specific details to create a reusable code skeleton.
        """
        # Replace multi-line strings
        code = re.sub(r'"""[\s\S]*?"""', '"""..."""', code)
        code = re.sub(r"'''[\s\S]*?'''", "'''...'''", code)
        # Replace normal strings
        code = re.sub(r'".*?"', '"..."', code)
        code = re.sub(r"'.*?'", "'...'", code)
        return code

    def record_success(self, manifest: Any):
        """Records a successful tool generation."""
        skeleton = self._skeletonize(manifest.implementation)
        key = manifest.name
        
        if key in self.patterns:
            self.patterns[key].success_count += 1
            # Update skeleton in case it improved
            self.patterns[key].implementation_skeleton = skeleton
        else:
            self.patterns[key] = Pattern(
                tool_name=manifest.name,
                description=manifest.description,
                category=self._categorize(manifest.description),
                implementation_skeleton=skeleton,
                libraries_used=manifest.dependencies,
                success_count=1,
                tags=manifest.tags
            )
        self.save()

    def record_failure(self, manifest: Any, error: str):
        """Records a failed tool generation attempt."""
        key = manifest.name
        if key in self.patterns:
            self.patterns[key].failure_count += 1
        else:
            skeleton = self._skeletonize(manifest.implementation)
            self.patterns[key] = Pattern(
                tool_name=manifest.name,
                description=manifest.description,
                category=self._categorize(manifest.description),
                implementation_skeleton=skeleton,
                libraries_used=manifest.dependencies,
                failure_count=1,
                tags=manifest.tags
            )
        self.save()

    def _categorize(self, description: str) -> str:
        desc = description.lower()
        if any(w in desc for w in ["scrap", "crawl", "spider", "soup"]): return "scraping"
        if any(w in desc for w in ["parse", "extract", "regex", "json"]): return "parsing"
        if any(w in desc for w in ["transform", "convert", "process", "map"]): return "transformation"
        if any(w in desc for w in ["api ", " api", "http", "request", "rest", "endpoint"]): return "api-integration"
        if any(w in desc for w in ["file", "disk", "read", "write", "path"]): return "filesystem"
        return "general"

    def get_similar_patterns(self, description: str) -> List[Pattern]:
        """Finds top patterns matching the target task's description."""
        category = self._categorize(description)
        # return top 3 successful patterns in the same category
        results = [p for p in self.patterns.values() if p.category == category and p.success_count > p.failure_count]
        
        # Sort by success count, then by fewer failures
        results.sort(key=lambda x: (x.success_count, -x.failure_count), reverse=True)
        return results[:3]
