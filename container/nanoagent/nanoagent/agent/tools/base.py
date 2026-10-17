"""Base class for agent tools."""

from abc import ABC, abstractmethod
from typing import Any, TYPE_CHECKING

if TYPE_CHECKING:
    from nanoagent.agent.permissions import PermissionMode


class Tool(ABC):
    """
    Abstract base class for agent tools.

    Tools are capabilities that the agent can use to interact with
    the environment, such as reading files, executing commands, etc.

    Each tool declares a ``required_permission`` tier.  The agent loop checks
    this against the active ``PermissionPolicy`` before calling ``execute()``.
    """

    # Default tier — override in subclasses that need higher privilege.
    # Import is deferred to avoid a circular dependency at module load time.
    @property
    def required_permission(self) -> "PermissionMode":
        from nanoagent.agent.permissions import PermissionMode
        return PermissionMode.ReadOnly

    _TYPE_MAP = {
        "string": str,
        "integer": int,
        "number": (int, float),
        "boolean": bool,
        "array": list,
        "object": dict,
    }
    
    @property
    @abstractmethod
    def name(self) -> str:
        """Tool name used in function calls."""
        pass
    
    @property
    @abstractmethod
    def description(self) -> str:
        """Description of what the tool does."""
        pass
    
    @property
    @abstractmethod
    def parameters(self) -> dict[str, Any]:
        """JSON Schema for tool parameters."""
        pass
    
    @abstractmethod
    async def execute(self, **kwargs: Any) -> str:
        """
        Execute the tool with given parameters.
        
        Args:
            **kwargs: Tool-specific parameters.
        
        Returns:
            String result of the tool execution.
        """
        pass

    def validate_params(self, params: dict[str, Any]) -> list[str]:
        """Validate tool parameters against JSON schema. Returns error list (empty if valid)."""
        schema = self.parameters or {}
        if schema.get("type", "object") != "object":
            raise ValueError(f"Schema must be object type, got {schema.get('type')!r}")
        return self._validate(params, {**schema, "type": "object"}, "")

    @staticmethod
    def _coerce(val: Any, schema: dict[str, Any]) -> Any:
        """Repair the one type error models actually make: a JSON string where a
        number or boolean was declared.

        Found live 2026-08-29 (test 3.4, a live cycle: a model called effector with
        `max_turns: "15"`. The call was rejected with "max_turns should be integer", the
        model recovered by dropping the argument entirely, and the run continued on the
        default — so a rejected call cost a turn and silently changed the request. LLMs
        emit digits-as-strings constantly; a whole tool call is a lot to throw away over
        two quote characters.

        Deliberately narrow. Only a `str` toward a declared numeric or boolean type, and
        only when the string parses exactly — `int("15")`, not `int(15.7)` or `int("15
        turns")`. Anything ambiguous is left alone and still fails validation, loudly, as
        it should: this repairs a formatting slip, it does not guess at intent.

        Note `bool` before `int`: in Python bool is a subclass of int, so an unguarded
        int branch would turn "true" into an error rather than True.
        """
        t = schema.get("type")
        if not isinstance(val, str):
            return val
        text = val.strip()
        if t == "boolean":
            low = text.lower()
            if low in ("true", "false"):
                return low == "true"
            return val
        if t == "integer":
            try:
                return int(text)
            except ValueError:
                return val
        if t == "number":
            try:
                return float(text)
            except ValueError:
                return val
        return val

    def _validate(self, val: Any, schema: dict[str, Any], path: str) -> list[str]:
        t, label = schema.get("type"), path or "parameter"
        if t in self._TYPE_MAP and not isinstance(val, self._TYPE_MAP[t]):
            return [f"{label} should be {t}"]
        
        errors = []
        if "enum" in schema and val not in schema["enum"]:
            errors.append(f"{label} must be one of {schema['enum']}")
        if t in ("integer", "number"):
            if "minimum" in schema and val < schema["minimum"]:
                errors.append(f"{label} must be >= {schema['minimum']}")
            if "maximum" in schema and val > schema["maximum"]:
                errors.append(f"{label} must be <= {schema['maximum']}")
        if t == "string":
            if "minLength" in schema and len(val) < schema["minLength"]:
                errors.append(f"{label} must be at least {schema['minLength']} chars")
            if "maxLength" in schema and len(val) > schema["maxLength"]:
                errors.append(f"{label} must be at most {schema['maxLength']} chars")
        if t == "object":
            props = schema.get("properties", {})
            for k in schema.get("required", []):
                if k not in val:
                    errors.append(f"missing required {path + '.' + k if path else k}")
            for k, v in list(val.items()):
                if k not in props:
                    continue
                # Coerce BEFORE validating, and write the coerced value back so
                # execute() receives it — see _coerce for why this is here at all.
                v = self._coerce(v, props[k])
                val[k] = v
                errors.extend(self._validate(v, props[k], path + '.' + k if path else k))
        if t == "array" and "items" in schema:
            for i, item in enumerate(val):
                # Same coerce-then-write-back as the object branch above: a list of
                # digits-strings is exactly as common as a single one.
                item = self._coerce(item, schema["items"])
                val[i] = item
                errors.extend(self._validate(item, schema["items"], f"{path}[{i}]" if path else f"[{i}]"))
        return errors
    
    def to_schema(self) -> dict[str, Any]:
        """Convert tool to OpenAI function schema format."""
        return {
            "type": "function",
            "function": {
                "name": self.name,
                "description": self.description,
                "parameters": self.parameters,
            }
        }
