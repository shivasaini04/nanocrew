"""A generated tool must fetch through the shared capability, not its own client.

The whole argument for letting an agent write its own source tools rests on the generated
tool inheriting the protections the built-ins learned the hard way. It inherits none of
them if it can just `import httpx`, so the scanner has to say no — and say it in a way the
model can act on, since a rejection is fed straight back into regeneration.
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from nanoagent.agent.tools.dynamic.security import SecurityScanner  # noqa: E402

SCANNER = SecurityScanner()


def _violations(code: str, tier: str = "sandbox"):
    return SCANNER.scan(code, "python", tier).violations


def _rules(code: str, tier: str = "sandbox"):
    return {v.rule for v in _violations(code, tier)}


def test_direct_httpx_is_refused():
    assert "use-source-fetch" in _rules("import httpx\ndef main(**k):\n    return 1\n")


def test_requests_and_aiohttp_are_refused():
    assert "use-source-fetch" in _rules("import requests\ndef main(**k): return 1\n")
    assert "use-source-fetch" in _rules("import aiohttp\ndef main(**k): return 1\n")


def test_from_import_of_a_network_client_is_refused():
    assert "use-source-fetch" in _rules("from httpx import AsyncClient\ndef main(**k): return 1\n")


def test_urllib_request_is_refused_but_urllib_parse_is_not():
    """The distinction matters: parsing a URL is not the risk, fetching one is. Blocking
    urllib wholesale would push the model into worse workarounds."""
    assert "use-source-fetch" in _rules("from urllib import request\ndef main(**k): return 1\n")
    assert "use-source-fetch" in _rules("import urllib.request\ndef main(**k): return 1\n")

    assert "use-source-fetch" not in _rules("from urllib.parse import urlparse\ndef main(**k): return 1\n")
    assert "use-source-fetch" not in _rules("import urllib.parse\ndef main(**k): return 1\n")


def test_the_capability_itself_is_allowed():
    code = (
        "from nanoagent.agent.source_fetch import fetch, record_yield\n"
        "async def main(**k):\n"
        "    res = await fetch('https://www.linkedin.com/x')\n"
        "    record_yield('linkedin.com', 3)\n"
        "    return res.text\n"
    )
    assert _violations(code) == []


def test_the_refusal_tells_the_model_what_to_do_instead():
    """A bare 'forbidden' would just get retried with `requests`."""
    msg = next(v for v in _violations("import httpx\ndef main(**k): return 1\n")
               if v.rule == "use-source-fetch").description

    assert "nanoagent.agent.source_fetch" in msg
    assert "fetch(url)" in msg
    assert "record_yield" in msg


def test_the_source_rules_reach_the_model_at_authoring_time():
    """Enforcement is not enough on its own. The scanner stops a generated tool building
    its own client, but a retry loop around a 429 lives in the caller and scans clean — so
    the model has to be told the stop is terminal before it writes the loop."""
    from nanoagent.agent.source_fetch import known_sources_brief

    brief = known_sources_brief()

    assert "linkedin.com" in brief
    assert "429" in brief
    # The numbers must come from the enforced profiles, not a second hand-written copy.
    from nanoagent.agent import source_fetch as sf

    assert str(sf._PROFILES["linkedin.com"].per_cycle_budget) in brief


def test_sidecar_tier_is_still_relaxed():
    """Sidecar runs in its own container and is the deliberate escape hatch — the existing
    design already relaxes the module blocklist there, and this rule follows suit."""
    assert _violations("import httpx\ndef main(**k): return 1\n", tier="sidecar") == []
