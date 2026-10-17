# Writing skills and tools

## Skills

A skill is a folder under `container/nanoagent/nanoagent/skills/<name>/` with a `SKILL.md`. The agent sees the name
and description, and loads the body when the task matches.

```markdown
---
name: my-skill
description: One line that says when to use this skill.
version: 1.0.0
author: you
license: MIT
metadata:
  tags: [example]
---

# My skill

Step-by-step instructions the agent follows. Put long reference material in `references/`
and helper scripts in `scripts/`.
```

Keep the description specific: it is what the agent matches against. Record the license of anything you copy and
add it to [THIRD_PARTY.md](../THIRD_PARTY.md).

## Tools

A tool is a Python class in `container/nanoagent/nanoagent/agent/tools/` that subclasses `Tool` from `base.py`:

```python
from typing import Any
from nanoagent.agent.tools.base import Tool

class EchoTool(Tool):
    @property
    def name(self) -> str: return "echo"
    @property
    def description(self) -> str: return "Return the given text."
    @property
    def parameters(self) -> dict[str, Any]:
        return {"type": "object", "properties": {"text": {"type": "string"}}, "required": ["text"]}
    async def execute(self, **kwargs: Any) -> str:
        return kwargs["text"]
```

Register it where the built-in tools are registered in `agent/loop.py` (`self.tools.register(...)`). Override
`required_permission` for tools that write or run commands, so the permission policy can gate them. Add a test under
`container/nanoagent/tests/`.

## External tools

Use MCP servers for tools that should live outside the agent runtime. The dashboard has an MCP page for adding them.
