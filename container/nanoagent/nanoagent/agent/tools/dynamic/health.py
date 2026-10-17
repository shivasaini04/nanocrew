import json
import os
import time
from dataclasses import dataclass, field, asdict
from typing import Dict, List, Optional, Any
from loguru import logger

@dataclass
class ToolHealth:
    tool_name: str
    status: str = "healthy"  # "healthy" | "degraded" | "failing"
    total_calls: int = 0
    success_rate: float = 1.0
    avg_latency_ms: float = 0.0
    p95_latency_ms: float = 0.0
    last_error: Optional[str] = None
    last_success: Optional[str] = None
    last_rollback_at: Optional[float] = None
    needs_regeneration: bool = False
    
    # Internal tracking for rolling metrics
    _history: List[Dict[str, Any]] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        d = asdict(self)
        d.pop("_history", None)
        return d


class ToolHealthMonitor:
    def __init__(self, event_emitter: Any = None, rollback_trigger: Any = None, persist_path: Optional[str] = None):
        self._health_map: Dict[str, ToolHealth] = {}
        self._event_emitter = event_emitter
        self._rollback_trigger = rollback_trigger
        # Phase 5a (stage25): persist health across cycles. Each cycle is a fresh
        # container, so without this the rolling success-rate window (and therefore
        # the auto-rollback signal) would reset every cycle and never accumulate.
        self._persist_path = persist_path
        self._load()

    def _load(self) -> None:
        if not self._persist_path or not os.path.exists(self._persist_path):
            return
        try:
            with open(self._persist_path, "r", encoding="utf-8") as f:
                data = json.load(f)
            for name, d in data.items():
                h = ToolHealth(tool_name=name)
                for k, v in d.items():
                    if k != "_history" and hasattr(h, k):
                        setattr(h, k, v)
                h._history = d.get("_history", []) or []
                self._health_map[name] = h
        except Exception:
            pass  # corrupt/partial health store — start fresh, never block tool execution

    def _save(self) -> None:
        if not self._persist_path:
            return
        try:
            os.makedirs(os.path.dirname(self._persist_path), exist_ok=True)
            out = {name: asdict(h) for name, h in self._health_map.items()}  # asdict keeps _history
            tmp = self._persist_path + ".tmp"
            with open(tmp, "w", encoding="utf-8") as f:
                json.dump(out, f, indent=2)
            os.replace(tmp, self._persist_path)
        except Exception:
            pass  # persistence is best-effort — never let it break a tool call

    def _update_metrics(self, health: ToolHealth, success: bool, latency_ms: float, error: Optional[str] = None):
        health._history.append({
            "success": success,
            "latency": latency_ms,
            "error": error,
            "timestamp": time.time()
        })
        # Keep last 100 executions
        if len(health._history) > 100:
            health._history.pop(0)

        health.total_calls += 1
        
        recent_successes = sum(1 for h in health._history if h["success"])
        health.success_rate = recent_successes / len(health._history)
        
        latencies = sorted(h["latency"] for h in health._history)
        health.avg_latency_ms = sum(latencies) / len(latencies) if latencies else 0.0
        p95_idx = int(len(latencies) * 0.95)
        # Handle index matching
        if p95_idx >= len(latencies):
            p95_idx = len(latencies) - 1
        health.p95_latency_ms = latencies[p95_idx] if latencies else 0.0
        
        now_iso = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
        if success:
            health.last_success = now_iso
        else:
            health.last_error = error
            
        old_status = health.status
        if health.success_rate >= 0.9:
            health.status = "healthy"
        elif 0.7 <= health.success_rate < 0.9:
            health.status = "degraded"
        else:
            health.status = "failing"
            
        health.needs_regeneration = health.status == "failing"
        
        if old_status != health.status:
            logger.warning(f"Tool {health.tool_name} health changed: {old_status} -> {health.status} (Success Rate: {health.success_rate:.2f})")
            if self._event_emitter and hasattr(self._event_emitter, "emit_health_changed"):
                # Pass health dictionary to event
                self._event_emitter.emit_health_changed(health.tool_name, health.status, health.to_dict())
            
            # Milestone 4.5: Auto-rollback on "failing" status
            if health.status == "failing" and self._rollback_trigger:
                # Prevent rollback loops (e.g. only once every 10 minutes)
                now = time.time()
                last_roll = health.last_rollback_at if health.last_rollback_at else 0
                if (now - last_roll > 600):
                    logger.warning(f"Tool {health.tool_name} is failing. Triggering auto-rollback.")
                    health.last_rollback_at = now
                    self._rollback_trigger(health.tool_name)

    def record_execution(self, tool_name: str, success: bool, latency_ms: float, error: Optional[str] = None):
        """Record a single execution of a tool."""
        if tool_name not in self._health_map:
            self._health_map[tool_name] = ToolHealth(tool_name=tool_name)
            
        health = self._health_map[tool_name]
        self._update_metrics(health, success, latency_ms, error)
        self._save()

    def get_health(self, tool_name: str) -> Optional[ToolHealth]:
        """Get the current health of a tool."""
        return self._health_map.get(tool_name)
        
    def check_all(self) -> List[ToolHealth]:
        """Return the health status of all tracked tools."""
        return list(self._health_map.values())
