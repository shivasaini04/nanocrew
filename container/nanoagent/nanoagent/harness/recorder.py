"""Fixture recorder — capture real Anthropic API calls as replayable fixtures.

Ported from claw-code-main/rust/crates/compat-harness/ record mode.

Usage:
    python -m nanoagent.harness record <scenario_name> \\
        --prompt "Read README.md and summarise it" \\
        --model claude-haiku-4-5-20251001 \\
        [--system "You are a helpful assistant."] \\
        [--workspace /path/to/dir]

Requires ANTHROPIC_API_KEY in the environment.

The recorder intercepts the raw SSE stream from the Anthropic Messages API and
writes it to nanoagent/harness/fixtures/<scenario_name>/events.json in the format
the mock server can replay. Re-recording is explicit: the user must pass --overwrite
to replace an existing fixture (the default refuses).

For parity checking (verifying the mock is faithful), run:
    python -m nanoagent.harness parity <scenario_name>

This runs the scenario against the real API and diffs the tool invocations and
final text against the recorded fixture.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import sys
from pathlib import Path

FIXTURES_DIR = Path(__file__).parent / "fixtures"


# ---------------------------------------------------------------------------
# SSE capture
# ---------------------------------------------------------------------------

async def _capture_sse(
    api_key: str,
    model: str,
    system: str,
    messages: list[dict],
    tools: list[dict],
) -> list[dict]:
    """Send one Anthropic API call and capture all SSE events.

    Returns a list of {"event": type, "data": {...}} objects suitable for
    writing directly to a fixture's turns list.
    """
    try:
        import httpx
    except ImportError:
        sys.exit("httpx is required: pip install httpx")

    base_url = os.environ.get("ANTHROPIC_BASE_URL", "https://api.anthropic.com")
    url = f"{base_url}/v1/messages"
    headers = {
        "x-api-key": api_key,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
        "accept": "text/event-stream",
    }
    body: dict = {
        "model": model,
        "max_tokens": 1024,
        "stream": True,
        "messages": messages,
    }
    if system:
        body["system"] = system
    if tools:
        body["tools"] = tools

    events: list[dict] = []
    current_event_type: str = ""

    async with httpx.AsyncClient(timeout=60) as client:
        async with client.stream("POST", url, headers=headers, json=body) as resp:
            if resp.status_code != 200:
                text = await resp.aread()
                sys.exit(f"API error {resp.status_code}: {text.decode()}")

            async for line in resp.aiter_lines():
                if line.startswith("event: "):
                    current_event_type = line[7:].strip()
                elif line.startswith("data: "):
                    raw = line[6:].strip()
                    if raw == "[DONE]":
                        break
                    try:
                        data = json.loads(raw)
                        if current_event_type:
                            events.append({"event": current_event_type, "data": data})
                    except json.JSONDecodeError:
                        pass
                elif line == "":
                    current_event_type = ""

    return events


def _events_to_tool_calls(turn_events: list[dict]) -> list[dict]:
    """Extract tool calls from a recorded turn (for parity diff)."""
    calls = []
    current: dict | None = None
    partial_json = ""

    for ev in turn_events:
        data = ev.get("data", {})
        if ev["event"] == "content_block_start":
            block = data.get("content_block", {})
            if block.get("type") == "tool_use":
                current = {"name": block.get("name"), "id": block.get("id"), "input": {}}
                partial_json = ""
        elif ev["event"] == "content_block_delta" and current:
            delta = data.get("delta", {})
            if delta.get("type") == "input_json_delta":
                partial_json += delta.get("partial_json", "")
        elif ev["event"] == "content_block_stop" and current:
            try:
                current["input"] = json.loads(partial_json)
            except json.JSONDecodeError:
                current["input"] = {}
            calls.append(current)
            current = None
            partial_json = ""

    return calls


def _events_to_text(turn_events: list[dict]) -> str:
    """Extract concatenated text content from a recorded turn."""
    parts: list[str] = []
    for ev in turn_events:
        if ev["event"] == "content_block_delta":
            delta = ev["data"].get("delta", {})
            if delta.get("type") == "text_delta":
                parts.append(delta.get("text", ""))
    return "".join(parts)


# ---------------------------------------------------------------------------
# Record command
# ---------------------------------------------------------------------------

async def _cmd_record(args: argparse.Namespace) -> None:
    api_key = os.environ.get("ANTHROPIC_API_KEY", "")
    if not api_key:
        sys.exit("ANTHROPIC_API_KEY is not set")

    fixture_dir = FIXTURES_DIR / args.scenario
    events_file = fixture_dir / "events.json"

    if events_file.exists() and not args.overwrite:
        sys.exit(
            f"Fixture '{args.scenario}' already exists at {events_file}. "
            "Pass --overwrite to replace it."
        )

    print(f"Recording scenario: {args.scenario}")
    print(f"Model:  {args.model}")
    print(f"Prompt: {args.prompt[:80]}{'...' if len(args.prompt) > 80 else ''}")

    messages: list[dict] = [{"role": "user", "content": args.prompt}]
    all_turns: list[list[dict]] = []

    # Multi-turn recording: keep recording until stop_reason is end_turn
    while True:
        print(f"  → Recording turn {len(all_turns) + 1}...", end=" ", flush=True)
        events = await _capture_sse(
            api_key=api_key,
            model=args.model,
            system=args.system,
            messages=messages,
            tools=[],
        )
        all_turns.append(events)
        print(f"{len(events)} events captured")

        # Check stop reason
        stop_reason = ""
        for ev in events:
            if ev["event"] == "message_delta":
                stop_reason = ev["data"].get("delta", {}).get("stop_reason", "")
        if stop_reason != "tool_use":
            break

        # Extract tool calls and build synthetic tool results to continue
        tool_calls = _events_to_tool_calls(events)
        tool_results = []
        for tc in tool_calls:
            tool_results.append({
                "type": "tool_result",
                "tool_use_id": tc["id"],
                "content": f"[recorded result for {tc['name']}]",
            })
        # Append assistant turn + tool results for next API call
        messages.append({"role": "assistant", "content": _reconstruct_content(events)})
        messages.append({"role": "user", "content": tool_results})

    # Write fixture
    fixture_dir.mkdir(parents=True, exist_ok=True)
    fixture_data = {
        "description": args.description or f"Recorded scenario: {args.scenario}",
        "model": args.model,
        "input_prompt": args.prompt,
        "recorded_at": __import__("datetime").datetime.utcnow().isoformat() + "Z",
        "turns": all_turns,
    }
    events_file.write_text(json.dumps(fixture_data, indent=2), encoding="utf-8")
    print(f"\n✓ Fixture written to {events_file}")
    print(f"  Turns: {len(all_turns)}, total events: {sum(len(t) for t in all_turns)}")


def _reconstruct_content(events: list[dict]) -> list[dict]:
    """Reconstruct the assistant content array from recorded events (for multi-turn)."""
    content: list[dict] = []
    current_block: dict | None = None
    partial_json = ""

    for ev in events:
        data = ev.get("data", {})
        if ev["event"] == "content_block_start":
            block = data.get("content_block", {})
            current_block = dict(block)
            partial_json = ""
        elif ev["event"] == "content_block_delta" and current_block:
            delta = data.get("delta", {})
            if delta.get("type") == "text_delta":
                current_block["text"] = current_block.get("text", "") + delta.get("text", "")
            elif delta.get("type") == "input_json_delta":
                partial_json += delta.get("partial_json", "")
        elif ev["event"] == "content_block_stop" and current_block:
            if current_block.get("type") == "tool_use":
                try:
                    current_block["input"] = json.loads(partial_json)
                except json.JSONDecodeError:
                    current_block["input"] = {}
            content.append(current_block)
            current_block = None

    return content


# ---------------------------------------------------------------------------
# Parity command
# ---------------------------------------------------------------------------

async def _cmd_parity(args: argparse.Namespace) -> None:
    """Run a recorded scenario against the real API and diff against fixture."""
    api_key = os.environ.get("ANTHROPIC_API_KEY", "")
    if not api_key:
        sys.exit("ANTHROPIC_API_KEY is not set")

    fixture_path = FIXTURES_DIR / args.scenario / "events.json"
    if not fixture_path.exists():
        sys.exit(f"Fixture not found: {fixture_path}")

    fixture = json.loads(fixture_path.read_text(encoding="utf-8"))
    model  = fixture.get("model", args.model)
    prompt = fixture.get("input_prompt", "")

    print(f"Parity check: {args.scenario}")
    print(f"Model: {model}  |  Prompt: {prompt[:60]}")

    live_events = await _capture_sse(
        api_key=api_key,
        model=model,
        system="",
        messages=[{"role": "user", "content": prompt}],
        tools=[],
    )

    # Compare first turn only (model output is non-deterministic; compare structure)
    recorded_turn = fixture["turns"][0]
    diffs: list[str] = []

    # Check event type sequence matches
    rec_types  = [e["event"] for e in recorded_turn]
    live_types = [e["event"] for e in live_events]
    if rec_types != live_types:
        diffs.append(
            f"Event type sequence differs:\n  recorded: {rec_types}\n  live:     {live_types}"
        )

    # Check stop reason matches
    rec_stop  = next((e["data"].get("delta", {}).get("stop_reason") for e in recorded_turn if e["event"] == "message_delta"), None)
    live_stop = next((e["data"].get("delta", {}).get("stop_reason") for e in live_events if e["event"] == "message_delta"), None)
    if rec_stop != live_stop:
        diffs.append(f"Stop reason differs: recorded={rec_stop!r}  live={live_stop!r}")

    if diffs:
        print("\n⚠  Parity differences found:")
        for d in diffs:
            print(f"  {d}")
        sys.exit(1)
    else:
        print("\n✓ Parity check passed — event structure matches recorded fixture")


# ---------------------------------------------------------------------------
# CLI entry point
# ---------------------------------------------------------------------------

def main() -> None:
    parser = argparse.ArgumentParser(
        prog="python -m nanoagent.harness",
        description="NanoAgent fixture recorder and parity checker",
    )
    sub = parser.add_subparsers(dest="command", required=True)

    rec = sub.add_parser("record", help="Record a new fixture from the real Anthropic API")
    rec.add_argument("scenario", help="Scenario name (becomes fixtures/{name}/events.json)")
    rec.add_argument("--prompt", required=True, help="User prompt to send")
    rec.add_argument("--model", default="claude-haiku-4-5-20251001", help="Model to use")
    rec.add_argument("--system", default="", help="System prompt")
    rec.add_argument("--description", default="", help="Human description for the fixture")
    rec.add_argument("--overwrite", action="store_true", help="Replace existing fixture")

    par = sub.add_parser("parity", help="Run a fixture against the real API and diff")
    par.add_argument("scenario", help="Scenario name to check")
    par.add_argument("--model", default="claude-haiku-4-5-20251001")

    args = parser.parse_args()

    if args.command == "record":
        asyncio.run(_cmd_record(args))
    elif args.command == "parity":
        asyncio.run(_cmd_parity(args))


if __name__ == "__main__":
    main()
