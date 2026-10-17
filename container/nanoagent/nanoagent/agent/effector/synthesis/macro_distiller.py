"""Neural Macro Distillation Engine for Effector.

Compiles successful LLM browsing sessions into deterministic,
zero-token executable Python macros with pre- and post-condition assertions.
"""

from __future__ import annotations

import hashlib
import json
import re
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import TYPE_CHECKING, Any
from urllib.parse import urlparse

if TYPE_CHECKING:
    from nanoagent.agent.effector.action_log import ActionLogEntry


# Bumped when a change makes an older macro unsafe to replay rather than merely
# different. v2: values the model chose are parameters, not frozen literals.
MACRO_SCHEMA_VERSION = 2


@dataclass
class MacroAssertion:
    assertion_type: str  # "url_contains" | "element_visible" | "title_contains"
    expected: str
    target: str | None = None


@dataclass
class MacroAction:
    step_index: int
    action: str  # any effector action name — "click", "type", "navigate", "extract", ...
    target: str | None = None
    param_key: str | None = None  # if parameterized
    literal_value: str | None = None
    assertions: list[MacroAssertion] = field(default_factory=list)
    # The element's accessible name/role, recorded alongside the CSS selector so replay
    # can fall back to an a11y lookup when a generated class name has changed since the
    # macro was distilled. See executor._durable_descriptor.
    target_name: str | None = None
    target_role: str | None = None
    # Per-action payload the original step carried — without these, replaying a
    # `navigate` has no URL, a `key` has no key, and an `extract` has no schema, so
    # the fast path could only ever reproduce clicks and typing.
    url: str | None = None
    key: str | None = None
    extract_schema: dict[str, str] | None = None
    # Resolved live on replay from the vault, never stored. A macro distilled from a
    # login flow is exactly the case this engine is most valuable for, and it must not
    # carry the secret — see action_log.build_log_entry.
    credential_ref: str | None = None


@dataclass
class MacroWorkflow:
    workflow_id: str
    domain: str
    goal: str
    goal_hash: str
    parameters: list[str]
    actions: list[MacroAction]
    created_at: str = field(default_factory=lambda: datetime.now(timezone.utc).isoformat())
    success_count: int = 1
    # 1 → typed values frozen as literals. 2 → values the model chose are parameters
    # (stage 49). A v1 macro on disk still has `parameters: []` and its literals intact,
    # so nothing downstream would notice it is unsafe; the replay gate refuses it by
    # version and it is re-distilled, correctly, after the next real run.
    version: int = MACRO_SCHEMA_VERSION
    # Where the verified run that produced this macro ENDED (host + path). A replay is
    # only a success if it ends there too. Stage 61, found live 2026-09-19: a login macro
    # replayed all three steps, stayed on /login, and reported success — nothing compared
    # where the replay ended with where the real run had.
    end_url: str | None = None
    # False for every macro written before end states were recorded. Such a macro has no
    # way to tell a replay that worked from one that didn't, so the replay gate refuses it
    # and the next real run re-distills it (see react_loop._try_macro_fast_path).
    end_state_recorded: bool = False

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "MacroWorkflow":
        actions = []
        for a in data.get("actions", []):
            assertions = [MacroAssertion(**ass) for ass in a.get("assertions", [])]
            actions.append(MacroAction(
                step_index=a["step_index"],
                action=a["action"],
                target=a.get("target"),
                param_key=a.get("param_key"),
                literal_value=a.get("literal_value"),
                assertions=assertions,
                target_name=a.get("target_name"),
                target_role=a.get("target_role"),
                url=a.get("url"),
                key=a.get("key"),
                extract_schema=a.get("extract_schema"),
                credential_ref=a.get("credential_ref"),
            ))
        return cls(
            workflow_id=data["workflow_id"],
            domain=data["domain"],
            goal=data["goal"],
            goal_hash=data["goal_hash"],
            parameters=data.get("parameters", []),
            actions=actions,
            created_at=data.get("created_at", ""),
            success_count=data.get("success_count", 1),
            version=data.get("version", 1),
            end_url=data.get("end_url"),
            end_state_recorded=bool(data.get("end_state_recorded", False)),
        )


def _compute_goal_hash(domain: str, goal: str) -> str:
    normalized = f"{domain.strip().lower()}:{re.sub(r'[^a-z0-9]', '', goal.strip().lower())}"
    return hashlib.sha256(normalized.encode()).hexdigest()[:16]


_REF_RE = re.compile(r"^@e\d+$", re.IGNORECASE)

# Actions that mean nothing on replay: perception-only, or the loop's own terminator.
# Dropping them is what turns a 20-turn exploratory run into a short, deterministic
# macro — most of those turns were the model looking around, not doing anything.
_SKIPPED_ACTIONS = frozenset({"screenshot", "verify", "done", "wait", "scroll", "hover"})

# Actions that cannot be replayed without knowing WHICH element to act on. `navigate`
# (url), `key` (keyboard-level), and `extract` with a schema all target nothing, so
# they stay replayable with no element identity at all.
_TARGETLESS_ACTIONS = frozenset({"navigate", "key"})

# Actions whose text is DATA the run happened to use, not structure the macro is made of.
# Everything typed into a page is one of: a name, an address, a reference, a message —
# true for the run it was recorded from and for no other.
_VALUE_BEARING_ACTIONS = frozenset({"type", "fill", "select", "select_combobox", "clear"})


def _value_came_from_the_goal(text: str, goal: str) -> bool:
    """True when this typed value appears in the goal the caller asked for.

    The line between a value that is safe to freeze into a macro and one that is not is
    not "is it data" — it is **who chose it**.

    A value present in the goal was specified by the caller. Macros match on an exact
    domain+goal hash, so any run that reuses this macro asked for that same goal, with
    that same value in it. Freezing it changes nothing and keeps the fast path free.

    A value absent from the goal was produced by the model — inferred, or invented on
    the spot to get past a required field. Freezing that promotes one run's guess into
    what the agent does every time, at zero decision calls, with no opportunity to
    notice. That is precisely what happened on example.com: the goal named an email,
    so `you@example.com` was the caller's; `John Doe` and `Paper Sorting Inc` were
    not in the goal, and were the model's own inventions.

    Substring rather than token matching: a goal says "use email you@example.com"
    and the field receives exactly that, but a message field receives a sentence the
    goal only paraphrases — and a paraphrase is the model's wording, not the caller's.
    """
    if not text or not goal:
        return False
    normalized_goal = re.sub(r"\s+", " ", goal).strip().lower()
    normalized_text = re.sub(r"\s+", " ", str(text)).strip().lower()
    # One or two characters match almost any goal by accident.
    if len(normalized_text) < 3:
        return False
    return normalized_text in normalized_goal


_SECRET_FIELD_RE = re.compile(r"pass(?:word|wd|code|phrase)?|\bpwd\b|\bpin\b|secret|\botp\b|one.?time|\b2fa\b|\btotp\b", re.IGNORECASE)


def _looks_like_secret_field(target: str | None, name: str | None) -> bool:
    """A field whose value must never be written into a macro, however it was chosen.

    `_value_came_from_the_goal` freezes a value the caller put in the goal — right for a
    name or a search term, wrong for a password: the macro file becomes one more place
    the secret sits in plain text, next to every other macro. Stage 61 phase 0 found a
    login macro holding `literal_value: "SuperSecretPassword!"`. A secret belongs in the
    vault and reaches a replay through `credential_ref`."""
    return bool(_SECRET_FIELD_RE.search(f"{target or ''} {name or ''}"))


def _param_key_for(target_name: str | None, target: str | None, step_num: int) -> str:
    """A stable, readable parameter name for a field: `your_name`, `company_name`.

    Derived from the element's accessible name so a caller supplying values can read the
    macro and know what each one is for. Falls back to the step position when a field has
    no usable name — unhelpful to read, but it still has to be supplied.
    """
    source = (target_name or target or "").strip().lower()
    slug = re.sub(r"[^a-z0-9]+", "_", source).strip("_")[:40]
    return slug or f"field_{step_num}"

# What action_log.build_log_entry writes in place of a credential's plaintext. Typing
# this string into a password field would "succeed" every time and log in never — a
# macro must carry the credential_ref and re-resolve it instead.
_REDACTION_MARKER = "[CREDENTIAL_REDACTED]"


def _stable_url_fragment(url: str | None) -> str | None:
    """The part of a URL worth asserting on across runs: host plus path, with the query
    string and fragment dropped. A record id or session token in the query differs on
    every run and would make the assertion fail on a page that is in fact correct.
    Returns None for a bare host with no path — asserting only the domain would catch
    nothing, since a macro is already scoped to its domain."""
    if not url:
        return None
    try:
        parsed = urlparse(url)
    except Exception:
        return None
    path = (parsed.path or "").rstrip("/")
    if not path or path == "":
        return None
    return f"{parsed.netloc}{path}" if parsed.netloc else path


def distill_macro_from_action_log(
    goal: str,
    domain: str,
    action_entries: list[dict[str, Any] | Any],
    parameter_values: dict[str, str] | None = None,
) -> MacroWorkflow:
    """Distill action log entries into a parameterized MacroWorkflow.

    Targets come from each entry's `result.resolved_target` — the durable identity the
    executor recorded when the step actually resolved — and NOT from `action.target`,
    which in a react_loop run is a "@e14"-style ref: an ordinal into that one turn's
    snapshot, pointing at a different element (or nothing) in any later run. An entry
    whose action needs an element but has no durable identity is dropped rather than
    distilled into a step that cannot replay; a caller can check `actions` against the
    entries it passed to see whether enough of the run survived to be worth saving.
    """
    goal_hash = _compute_goal_hash(domain, goal)
    workflow_id = f"macro_{domain.replace('.', '_')}_{goal_hash[:8]}"
    params_inv: dict[str, str] = {}
    if parameter_values:
        for k, v in parameter_values.items():
            if v and len(str(v)) > 1:
                params_inv[str(v)] = k

    actions: list[MacroAction] = []
    # Parameter names invented here for values the caller did not name, kept separate
    # from `params_inv` (which is keyed by explicit value) so the two cannot collide.
    auto_params: list[str] = []
    step_num = 0

    for raw in action_entries:
        entry = raw if isinstance(raw, dict) else getattr(raw, "__dict__", {})
        res = entry.get("result", {})
        if not isinstance(res, dict):
            res = {}
        if res.get("status") not in (None, "success"):
            continue

        act = entry.get("action", {})
        if not isinstance(act, dict):
            act = entry
        action_name = act.get("type") or act.get("action")
        text_val = act.get("text") or act.get("value")
        credential_ref = act.get("credential_ref")

        if not action_name or action_name in _SKIPPED_ACTIONS:
            continue

        resolved = res.get("resolved_target") or {}
        if not isinstance(resolved, dict):
            resolved = {}
        target = resolved.get("selector")
        if not target:
            # No durable identity recorded. Fall back to the logged target only when it
            # is already durable in its own right — a CSS selector or a text/role
            # description resolves the same way next run; a @ref does not.
            logged = act.get("target")
            if logged and not _REF_RE.match(str(logged).strip()):
                target = logged

        if not target and action_name not in _TARGETLESS_ACTIONS:
            # An `extract` driven purely by an extract_schema needs no element identity;
            # anything else that reached here would replay against nothing.
            if not (action_name == "extract" and act.get("extract_schema")):
                continue

        param_key = None
        literal_val = text_val

        if credential_ref or text_val == _REDACTION_MARKER:
            # Never carry the marker forward as a literal — replay resolves the ref.
            literal_val = None
        elif text_val and str(text_val) in params_inv:
            param_key = params_inv[str(text_val)]
            literal_val = None
        elif text_val and action_name in _VALUE_BEARING_ACTIONS and _looks_like_secret_field(target, resolved.get("name")):
            # Never frozen, even when the goal supplied it — see _looks_like_secret_field.
            # As a parameter it makes the macro unreplayable without it, so the ReAct
            # loop (which can use a credential_ref) handles it instead.
            param_key = _param_key_for(resolved.get("name"), target, step_num + 1)
            if param_key in auto_params:
                param_key = f"{param_key}_{step_num + 1}"
            auto_params.append(param_key)
            literal_val = None
        elif text_val and action_name in _VALUE_BEARING_ACTIONS and not _value_came_from_the_goal(text_val, goal):
            # A value the model produced rather than the caller specified becomes a
            # parameter, and the recorded value is NOT kept.
            #
            # Found live 2026-09-02 (stage 49). A macro distilled from an example.com
            # contact-form run froze four literals — including `John Doe` and
            # `Paper Sorting Inc`, both invented by the agent on the spot — and replayed
            # them at zero decision calls, reporting success each time. The first run of
            # that same task had invented an email too; had that run been distilled, every
            # later replay would have typed the invented address faithfully forever.
            #
            # A macro's durable part is the procedure: which elements, in what order,
            # with which assertions. The values belong to the run it was recorded from.
            # Freezing them turns "I once guessed this" into "I do this every time", with
            # no model in the loop to notice.
            #
            # Dropping the value rather than keeping it as a default is deliberate: a
            # default is just a literal that fires when nobody looks, which is the bug.
            # A parameter with no value supplied makes the macro unreplayable, and the
            # caller falls back to the ReAct loop — which reasons, and can ask.
            param_key = _param_key_for(resolved.get("name"), target, step_num + 1)
            if param_key in auto_params:
                # Two fields with the same accessible name — keep them distinct, or the
                # second would silently take the first's value on replay.
                param_key = f"{param_key}_{step_num + 1}"
            auto_params.append(param_key)
            literal_val = None

        assertions: list[MacroAssertion] = []
        if target and action_name in ("click", "fill", "select_combobox", "type", "select", "clear"):
            assertions.append(MacroAssertion(
                assertion_type="element_visible",
                expected="true",
                target=target,
            ))

        landed_on = _stable_url_fragment(res.get("url_after"))
        if landed_on:
            # Where this step actually left the browser, as the stable part of the URL
            # (host + path — ids and query strings differ run to run). Replaying into a
            # session that has since expired lands on a login page whose markup can
            # still match a generic selector; this is the assertion that notices.
            assertions.append(MacroAssertion(
                assertion_type="url_contains",
                expected=landed_on,
            ))

        step_num += 1
        actions.append(MacroAction(
            step_index=step_num,
            action=action_name,
            target=target,
            param_key=param_key,
            literal_value=literal_val,
            assertions=assertions,
            target_name=resolved.get("name"),
            target_role=resolved.get("role"),
            url=act.get("url"),
            key=act.get("key"),
            extract_schema=act.get("extract_schema"),
            credential_ref=credential_ref,
        ))

    return MacroWorkflow(
        workflow_id=workflow_id,
        domain=domain,
        goal=goal,
        goal_hash=goal_hash,
        # Explicit parameters first, then the ones inferred from typed values. Every
        # name here must be supplied for the macro to replay — see execute_macro.
        parameters=list(dict.fromkeys([*params_inv.values(), *auto_params])),
        actions=actions,
    )


def save_macro(macro: MacroWorkflow, workspace: Path) -> Path:
    """Persist the macro workflow to workspace `.effector/macros/{domain}/`."""
    safe_domain = "".join(c if c.isalnum() or c in ".-_" else "_" for c in macro.domain)
    macro_dir = Path(workspace) / ".effector" / "macros" / safe_domain
    macro_dir.mkdir(parents=True, exist_ok=True)
    out_path = macro_dir / f"{macro.workflow_id}.json"
    out_path.write_text(json.dumps(macro.to_dict(), indent=2), encoding="utf-8")
    return out_path


def load_macro(domain: str, workflow_id: str, workspace: Path) -> MacroWorkflow | None:
    """Load a macro workflow by domain and ID."""
    safe_domain = "".join(c if c.isalnum() or c in ".-_" else "_" for c in domain)
    macro_path = Path(workspace) / ".effector" / "macros" / safe_domain / f"{workflow_id}.json"
    if not macro_path.exists():
        return None
    try:
        data = json.loads(macro_path.read_text(encoding="utf-8"))
        return MacroWorkflow.from_dict(data)
    except Exception:
        return None


def find_matching_macro(domain: str, goal: str, workspace: Path) -> MacroWorkflow | None:
    """Find an existing compiled macro matching domain and goal hash."""
    goal_hash = _compute_goal_hash(domain, goal)
    safe_domain = "".join(c if c.isalnum() or c in ".-_" else "_" for c in domain)
    macro_dir = Path(workspace) / ".effector" / "macros" / safe_domain
    if not macro_dir.exists():
        return None

    for p in macro_dir.glob("*.json"):
        try:
            data = json.loads(p.read_text(encoding="utf-8"))
            if data.get("goal_hash") == goal_hash or data.get("goal") == goal:
                return MacroWorkflow.from_dict(data)
        except Exception:
            continue
    return None
