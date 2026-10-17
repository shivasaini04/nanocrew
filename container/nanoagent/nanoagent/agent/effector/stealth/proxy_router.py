"""Ported from computer-use/proxy-router.ts. Thin effector-facing wrapper over the
shared `agent/proxy_config.py` — the actual credential lookup lives there now (see its
docstring for why), so a third consumer doesn't triple the env-var-reading code
`linkedin_jobs.py`/`yc_jobs.py` already duplicate between themselves.
"""

from __future__ import annotations

from nanoagent.agent.proxy_config import (
    ProxyConfig,
    get_residential_proxy_config,
    should_route_through_proxy,
)

__all__ = ["ProxyConfig", "get_residential_proxy_config", "should_route_through_proxy"]


def playwright_proxy_kwargs() -> dict[str, str] | None:
    """`get_residential_proxy_config()` as the literal kwargs dict Playwright's
    `browser.new_context(proxy=...)` / `chromium.launch(proxy=...)` expects, or None
    if no proxy is configured."""
    cfg = get_residential_proxy_config()
    if cfg is None:
        return None
    out = {"server": cfg.server}
    if cfg.username:
        out["username"] = cfg.username
    if cfg.password:
        out["password"] = cfg.password
    return out
