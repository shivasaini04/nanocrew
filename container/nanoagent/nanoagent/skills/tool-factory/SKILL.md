# Skill: The Sandbox Factory (Dynamic Tool Generation)

You have the ability to extend your own capabilities at runtime by generating new, specialized tools. This is powered by the "Sandbox Factory."

## The Factory Mindset
- **Repetition is Waste**: If you find yourself performing a complex series of steps (e.g., regex extraction, DOM walking, data transformation) repeatedly, **build a tool for it**.
- **Specialization**: Create tools for specific websites, specific file formats, or specific complex calculations.
- **Safety First**: Your tools run in a sandbox. Always use `main(**kwargs)` as the entry point and ensure you return JSON-serializable data.

## Your Tools
| Tool | Purpose |
| :--- | :--- |
| `generate_tool` | Create a new tool. Requires name, schema, implementation, and tests. |
| `list_tools` | See what you've built vs what is hardcoded. |
| `remove_tool` | Cleanup temporary tools you no longer need. |

## Implementation Rules (Python)
- **Mandatory Entry Point**: `def main(**kwargs):`
- **Arguments**: All parameters defined in your JSON schema will be passed as keyword arguments to `main`.
- **Imports**: You can use standard libraries (math, json, re, etc.). If you need external ones, check `list_tools` or try importing them; the validator will warn you if they are missing.
- **Output**: Return a string, list, or dictionary. Avoid returning complex objects.

## Example: Weather Formatter
If you frequently fetch weather data but it's too messy:

**name**: `format-weather`
**description**: `Formats raw weather JSON into a human-readable summary.`
**implementation**:
```python
def main(raw_json):
    data = raw_json.get("current", {})
    temp = data.get("temp_c")
    cond = data.get("condition", {}).get("text")
    return f"It is currently {temp}°C and {cond}."
```

## Calling back into the agent (`host.*`)
Your tools aren't islands — they can use the agent's own powers through an injected `host`
object. To use it, **declare the capability** in `capabilities` — that runs your tool in the
sidecar (where `host` lives) and authorizes the call:

- **`host.search_memory(query)`** — declare `capabilities: ["search_memory"]`. Returns a list of
  `{type, content, relevance}` from the agent's long-term memory. Ground a tool in what the agent knows.
- **`host.send_message(text)`** — declare `capabilities: ["send_message"]`. Asks the operator. This is
  an external action, so it's **queued for operator approval** — it returns a status note, not a
  delivery confirmation.
- **`host.call_tool(name, args)`** — declare `capabilities: ["call_tool"]`. Calls another of your
  sidecar tools by name and returns its result, so you can compose tools. (Reaches your own sidecar
  tools, not the agent's built-ins. Meta-tools like `generate_tool` can't be called this way.)

```python
# capabilities: ["search_memory"]
def main(topic):
    facts = host.search_memory(topic)
    return {"topic": topic, "known_facts": [f["content"] for f in facts]}
```

Declaring any host capability runs your tool in the sidecar (where `host` lives). The verifier and
broker enforce these — you can only call what you declared.

## Security & Constraints
The verifier runs a security scan. Follow these up front so your tool passes on the first try:
- **Forbidden imports**: `os`, `subprocess`, `shutil`, `importlib`, `socket`.
- **Forbidden calls**: `eval`, `exec`, `compile`, `__import__`, `getattr`, `setattr`, and the bare builtin `open()`.
- **File I/O — use `pathlib`, not `open()`**: `from pathlib import Path; Path(p).read_text()`, `Path(p).write_text(s)`, or `Path(p).open("a")`. Persist data under `/workspace/group/workspace/`. (Tools CAN read/write files this way — that's how a tool keeps a log or cache.)
- **Allowed**: standard libs like `json`, `re`, `math`, `datetime`, `pathlib`, `itertools`, `collections`.

## Tests & Persistence
- Provide `test_cases`: a list of `{"input": {<kwargs for main>}, "expected_contains"?: str, "expected_type"?: str, "expected_status"?: "success"|"error"}`. **Do not add a `name` key.** The factory runs these and only registers the tool if they pass.
- If verification fails, read the error and call `generate_tool` again with the fix — don't resubmit the same code.
- Your tools **persist and are versioned** — they survive across sessions, and `update_tool` / `rollback_tool` let them improve over time. Use `remove_tool` only to delete one you no longer want.
