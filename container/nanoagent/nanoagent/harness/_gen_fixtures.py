"""One-time script to generate all 10 baseline fixture files."""
import json
from pathlib import Path

BASE = Path(__file__).parent / "fixtures"
MODEL = "claude-haiku-4-5-20251001"


def msg_start(idx=1, input_tokens=25):
    return {"event": "message_start", "data": {"type": "message_start", "message": {
        "id": f"msg_mock{idx:02d}", "type": "message", "role": "assistant",
        "content": [], "model": MODEL, "stop_reason": None, "stop_sequence": None,
        "usage": {"input_tokens": input_tokens, "output_tokens": 0},
    }}}


def text_block(text, index=0):
    return [
        {"event": "content_block_start", "data": {"type": "content_block_start", "index": index,
            "content_block": {"type": "text", "text": ""}}},
        {"event": "content_block_delta", "data": {"type": "content_block_delta", "index": index,
            "delta": {"type": "text_delta", "text": text}}},
        {"event": "content_block_stop",  "data": {"type": "content_block_stop",  "index": index}},
    ]


def tool_block(name, tool_id, args, index=0):
    return [
        {"event": "content_block_start", "data": {"type": "content_block_start", "index": index,
            "content_block": {"type": "tool_use", "id": tool_id, "name": name, "input": {}}}},
        {"event": "content_block_delta", "data": {"type": "content_block_delta", "index": index,
            "delta": {"type": "input_json_delta", "partial_json": json.dumps(args)}}},
        {"event": "content_block_stop",  "data": {"type": "content_block_stop",  "index": index}},
    ]


def end_turn(output_tokens=8):
    return [
        {"event": "message_delta", "data": {"type": "message_delta",
            "delta": {"stop_reason": "end_turn", "stop_sequence": None},
            "usage": {"output_tokens": output_tokens}}},
        {"event": "message_stop", "data": {"type": "message_stop"}},
    ]


def end_tool_use(output_tokens=20):
    return [
        {"event": "message_delta", "data": {"type": "message_delta",
            "delta": {"stop_reason": "tool_use", "stop_sequence": None},
            "usage": {"output_tokens": output_tokens}}},
        {"event": "message_stop", "data": {"type": "message_stop"}},
    ]


SCENARIOS = {
    "streaming_text": {
        "description": "Basic text-only response — verifies text delta coalescing.",
        "turns": [
            [msg_start(1)] + text_block("Hello! How can I help you today?") + end_turn(8),
        ],
    },

    "tool_call_roundtrip": {
        "description": "Single tool call (exec echo) followed by final text response.",
        "turns": [
            [msg_start(1)] + tool_block("exec", "toolu_mock01", {"command": "echo hello"}) + end_tool_use(15),
            [msg_start(2)] + text_block("The command ran successfully and printed: hello") + end_turn(12),
        ],
    },

    "write_file_allowed": {
        "description": "Model writes a file under WorkspaceWrite permission — file should exist after.",
        "turns": [
            [msg_start(1)] + tool_block("write_file", "toolu_mock02",
                {"path": "output.txt", "content": "hello from test"}) + end_tool_use(18),
            [msg_start(2)] + text_block('Done. I wrote "hello from test" to output.txt.') + end_turn(10),
        ],
    },

    "write_file_denied": {
        "description": "Model attempts write_file under ReadOnly permission — policy denies, loop continues.",
        "turns": [
            [msg_start(1)] + tool_block("write_file", "toolu_mock03",
                {"path": "output.txt", "content": "should not appear"}) + end_tool_use(18),
            [msg_start(2)] + text_block("I cannot write files — permission denied by policy.") + end_turn(10),
        ],
    },

    "multi_tool_single_turn": {
        "description": "Two tool calls in one assistant turn — tests sequential tool dispatch.",
        "turns": [
            [msg_start(1, 40)]
            + tool_block("exec", "toolu_mock04", {"command": "echo first"}, index=0)
            + tool_block("exec", "toolu_mock05", {"command": "echo second"}, index=1)
            + end_tool_use(25),
            [msg_start(2)] + text_block('Both commands ran: "first" then "second".') + end_turn(15),
        ],
    },

    "exec_roundtrip": {
        "description": "exec tool with stdout capture — DangerFullAccess permission required.",
        "turns": [
            [msg_start(1)] + tool_block("exec", "toolu_mock06",
                {"command": "echo nanocrew-test"}) + end_tool_use(15),
            [msg_start(2)] + text_block("Command output: nanocrew-test") + end_turn(8),
        ],
    },

    "exec_permission_approved": {
        "description": "exec with Prompt permission mode, auto-approving prompter.",
        "turns": [
            [msg_start(1)] + tool_block("exec", "toolu_mock07",
                {"command": "echo approved"}) + end_tool_use(15),
            [msg_start(2)] + text_block("Command ran after approval: approved") + end_turn(8),
        ],
    },

    "exec_permission_denied": {
        "description": "exec with Prompt permission mode, auto-denying prompter — error in tool_result.",
        "turns": [
            [msg_start(1)] + tool_block("exec", "toolu_mock08",
                {"command": "echo should-not-run"}) + end_tool_use(15),
            [msg_start(2)] + text_block(
                "I cannot run that command — it was denied by the permission policy.") + end_turn(12),
        ],
    },

    "compaction_trigger": {
        "description": "Conversation compacted when token threshold exceeded — loop continues cleanly.",
        "turns": [
            [msg_start(1, 200)]  + text_block("First response — building context.") + end_turn(6),
            [msg_start(2, 500)]  + text_block("Second response — context growing.") + end_turn(6),
            # Third turn with input_tokens above the test compaction threshold (1000)
            [msg_start(3, 2000)] + text_block("Third response — context was compacted, still working.") + end_turn(10),
        ],
    },

    "empty_tool_result": {
        "description": "Tool returns empty string — loop handles gracefully and agent continues.",
        "turns": [
            [msg_start(1)] + tool_block("exec", "toolu_mock09", {"command": "true"}) + end_tool_use(12),
            [msg_start(2)] + text_block("The command ran but produced no output.") + end_turn(8),
        ],
    },
}


if __name__ == "__main__":
    for name, data in SCENARIOS.items():
        d = BASE / name
        d.mkdir(parents=True, exist_ok=True)
        (d / "events.json").write_text(json.dumps(data, indent=2), encoding="utf-8")
        print(f"  wrote {name}/events.json  ({len(data['turns'])} turn(s))")
    print("Done.")
