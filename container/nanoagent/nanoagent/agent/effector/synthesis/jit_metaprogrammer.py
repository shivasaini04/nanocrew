"""See synthesis/__init__.py for why this adapts to the existing generate_tool
pipeline rather than porting jit-metaprogrammer.ts's own sandbox.

Lifecycle (matches the god-level design doc's framing, using real infra for steps
3-5): (1) react_loop detects a perceive/act dead end — the DOM has nothing the
standard primitives can act on; (2) a model authors a small Python tool matching
generate_tool's contract; (3) the existing security scanner + subprocess sandbox
audits it; (4) on success it's registered and immediately callable; (5) the outer
agent loop calls it on its next turn. Steps 3-4 are `GenerateToolTool.execute()`
itself — this module only does steps 1-2 and the handoff.
"""

from __future__ import annotations

import json
import re
import time
from typing import Any

from loguru import logger

from nanoagent.agent.effector.types import DOMSnapshot


def looks_like_unsupported_interface(snapshot: DOMSnapshot) -> bool:
    """Cheap, deterministic signal that the page has nothing the standard DOM-based
    perceive/act primitives can work with — a pure Canvas/WebGL app, a custom
    element tree behind closed shadow roots, a non-standard widget toolkit. Not an
    LLM call: synthesis is expensive, so the trigger has to be a real, cheap signal,
    not a judgment call made every turn."""
    return len(snapshot.elements) == 0


_SYNTHESIS_PROMPT = """You are authoring a small tool to solve a specific problem an
autonomous browser agent hit: the page has no standard interactive elements the
normal DOM-based click/type primitives can see (likely a Canvas/WebGL app, a custom
web-component tree with closed shadow roots, or a non-HTML protocol like a raw
WebSocket feed).

PROBLEM: {problem_description}

PAGE CONTEXT (URL, title, any raw text/HTML sample available):
{page_context}

Write ONE tool that helps make progress on this problem — e.g. parsing a captured
network payload, decoding a custom binary format, computing something the agent
needs from raw page text. Respond with ONLY a JSON object, no explanation, no
markdown fences, matching this exact schema:

{{"name": "kebab-case-name", "description": "what it does and when to use it",
"parameters": {{"type": "object", "properties": {{...}}, "required": [...]}},
"implementation": "python source defining def main(**kwargs): ...",
"test_cases": [{{"input": {{...}}, "expected_status": "success"}}]}}

RULES the generated code MUST follow — the security sandbox enforces every one,
verified statically before your tool ever runs:
{generate_tool_rules}
"""


def _build_prompt(problem_description: str, page_context: str, generate_tool_rules: str) -> str:
    return _SYNTHESIS_PROMPT.format(
        problem_description=problem_description,
        page_context=page_context[:2000],
        generate_tool_rules=generate_tool_rules,
    )


# Real bug, found live 2026-08-27 (test 5.4, the first-ever live run of this whole
# module — pillar 01 had never fired against a real page before): the model's
# `implementation` field is raw Python source, and a bare backslash in it (a regex
# like \d+, a Windows path, an escape used as a docstring example) is not valid
# inside a JSON string unless doubled — json.loads then raises "Invalid \escape" on
# a spec whose actual content is otherwise fine. Live trace: synthesis on a
# canvas-only page failed with exactly this error and the whole attempt was
# discarded, even though every other field would have parsed correctly.
_INVALID_BACKSLASH_ESCAPE = re.compile(r'\\(?!["\\/bfnrtu]|u[0-9a-fA-F]{4})')


def _repair_invalid_backslash_escapes(text: str) -> str:
    """Doubles any backslash NOT already followed by a character JSON recognizes as
    a valid escape, leaving genuinely-correct escapes (\\n, \\", \\\\, \\uXXXX, ...)
    untouched. Not a general JSON repair — just the one failure mode raw source code
    embedded in a JSON string reliably produces."""
    return _INVALID_BACKSLASH_ESCAPE.sub(r"\\\\", text)


def _parse_spec_json(text: str) -> dict[str, Any]:
    cleaned = re.sub(r"```(?:json)?\n?", "", text or "").replace("```", "").strip()
    try:
        return json.loads(cleaned)
    except json.JSONDecodeError:
        # One repair pass, one retry — genuinely malformed JSON (missing braces,
        # wrong types, truncated output) still raises normally, out to the caller's
        # existing except-and-report-failure handling.
        return json.loads(_repair_invalid_backslash_escapes(cleaned))


async def synthesize_driver(
    problem_description: str,
    page_context: str,
    provider: Any,
    model: str,
    tool_registry: Any,
    persistence: Any = None,
    job_id: str | None = None,
    health_monitor: Any = None,
    usage_totals: dict | None = None,
) -> dict[str, Any]:
    """Ask `model` to author a tool solving `problem_description`, then register it
    through the real generate_tool pipeline (AST security scan, subprocess sandbox
    with resource limits, test-case verification, versioned persistence).

    Returns {"success": bool, "tool_name": str | None, "message": str}. Never
    raises — a failed synthesis attempt is a normal, expected outcome (the model's
    code didn't pass validation, or the problem genuinely isn't solvable this way),
    not an exceptional one.
    """
    from nanoagent.agent.tools.dynamic.generate import GenerateToolTool

    if tool_registry is None:
        return {"success": False, "tool_name": None, "message": "No tool registry available — synthesis requires the outer agent loop's registry."}

    gen_tool = GenerateToolTool(
        registry=tool_registry, persistence=persistence, job_id=job_id, health_monitor=health_monitor,
    )

    prompt = _build_prompt(problem_description, page_context, gen_tool.description)

    try:
        response = await provider.chat(
            messages=[{"role": "user", "content": prompt}],
            model=model,
            max_tokens=2048,
            temperature=0.2,
        )
        if usage_totals is not None:
            from nanoagent.agent.effector.types import accumulate_usage
            accumulate_usage(usage_totals, response.usage)
        spec = _parse_spec_json(response.content or "")
    except Exception as err:
        logger.warning(f"effector jit-metaprogrammer: synthesis prompt/parse failed — {err}")
        return {"success": False, "tool_name": None, "message": f"Synthesis failed to produce a valid spec: {err}"}

    required = ("name", "description", "parameters", "implementation")
    missing = [k for k in required if k not in spec]
    if missing:
        return {"success": False, "tool_name": None, "message": f"Synthesized spec missing required fields: {missing}"}

    try:
        message = await gen_tool.execute(**spec)
    except Exception as err:
        logger.warning(f"effector jit-metaprogrammer: generate_tool.execute raised — {err}")
        return {"success": False, "tool_name": None, "message": f"Tool registration failed: {err}"}

    success = message.startswith("Successfully generated tool")
    if success:
        logger.info(f"effector jit-metaprogrammer: synthesized and registered '{spec['name']}' for: {problem_description[:100]}")
    return {"success": success, "tool_name": spec["name"] if success else None, "message": message}
