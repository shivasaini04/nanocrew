"""self_manage — read and change this agent's own operating configuration.

One tool with an `action` rather than six separate tools, for the same reason the cron
tool is shaped that way: six near-identical schemas in the prompt buy nothing, and the
model picks the action far more reliably than it picks between six similar tool names.

Every action authenticates with NANOCREW_CYCLE_TOKEN — a per-cycle bearer token the
orchestrator puts in the request payload. Without it these routes return 401. That is
deliberate: unlike the other orchestrator callbacks (memory, handoffs, notifications),
these endpoints spend money and decide whether the agent runs at all.
"""

from __future__ import annotations

import json
import os
from typing import Any

from nanoagent.agent.tools.base import Tool


_CYCLE_TYPES = {"work", "lead_search", "send_outreach", "followup", "checkin", "self_improve", "custom"}


def _cycle_type(value: Any) -> str:
    v = str(value or "").strip().lower()
    return v if v in _CYCLE_TYPES else "work"


class SelfManageTool(Tool):
    """Inspect and change this agent's own operating configuration."""

    @property
    def name(self) -> str:
        return "self_manage"

    @property
    def description(self) -> str:
        return (
            "Read or change YOUR OWN operating settings: when you run, which model you use, how much you may spend, and whether you are enabled.\n"
            "This is the ONLY way to change your own settings. When your owner asks you to "
            "change how, when or what you run, do it here — never by editing files under "
            ".nanocrew/ yourself, and never by rewriting your instructions to describe a "
            "setting you did not actually change. After a change, read the result: if it says "
            "something is pending approval or will not run, tell your owner exactly that.\n"
            "Actions:\n"
            "  get        — read your current schedule, model, budget, status and next run.\n"
            "  schedule   — add to, remove from, or replace your recurring timers (WHEN you\n"
            "               wake up), and set your trigger mode. Give EACH job its own timer with\n"
            "               a name, an instruction (what to do when it fires) and your owner's\n"
            "               timezone — e.g. three jobs at three times = three timers. When a timer\n"
            "               fires you are told its name, its instruction and the time. If you are\n"
            "               switched off (idle) this also switches you on; the result says so.\n"
            "  sources    — WHICH lead source each scheduled run uses: a rotation such as\n"
            "               {linkedin_jobs: 2, yc_jobs: 1} means two LinkedIn turns per YC turn.\n"
            "               Timers set how many runs; the rotation sets what each one searches.\n"
            "               Also switches sweep gates on (off needs your owner).\n"
            "  run_once   — schedule ONE future run at a specific time, then forget it.\n"
            "  cancel_run — cancel a pending one-off run by id.\n"
            "  model      — switch your model / subagent model / thinking mode, or the model\n"
            "               used for one task type (task_models).\n"
            "  budget     — change your daily or monthly spend limit.\n"
            "  status     — arm ('running'), stop ('paused'), or hand the switch to your owner\n"
            "               ('stopped', which only they can undo).\n"
            "  identity   — change your own goals, role, personality, or ONE named section of\n"
            "               your system prompt. There is no whole-document replace: edits are\n"
            "               per-field, so a rewrite cannot quietly drop what it did not mention.\n"
            "  workspace  — change your pinned files and your custom folders.\n"
            "  tracker    — change your tracker's stages and fields.\n"
            "  rename     — change your own name. Your name is an ADDRESS: teammates hand off to\n"
            "               you by it, so a rename can orphan their handoffs. The result names\n"
            "               anyone still referring to the old one.\n"
            "  tools      — grant yourself a tool, or drop one you do not need. Tools that\n"
            "               contact people OUTSIDE the system (email, WhatsApp, voice) need your\n"
            "               owner's approval whatever else you hold — an internal change can be\n"
            "               reverted, a sent email cannot.\n"
            "  settings   — your ICP, escalation rules, wake policy (what may start you besides\n"
            "               your timers), WhatsApp notifications, job summaries. Using your owner's\n"
            "               own browser or an outbound webhook URL needs their approval to turn on.\n"
            "  approvals  — your owner's standing answers to 'may I do this without asking?'.\n"
            "               op 'list' shows them. When your owner tells you not to ask before\n"
            "               something (e.g. 'don't ask me before emailing me'), add a rule with\n"
            "               decision 'auto'; to make you always ask, decision 'ask'. You can only\n"
            "               stop asking when your owner says so in a conversation with you.\n"
            "  credentials— 'list' what you can already use, 'request' access you do not have,\n"
            "               'revoke' your own. You NEVER see a secret value: call the tool that\n"
            "               needs it and it is resolved at call time. Do not ask for the value.\n"
            "For schedules, pass `op`: 'add' to add or update entries, 'remove' to drop them "
            "by type, 'set' to replace the whole list. 'set' is the destructive one — it "
            "discards every entry you did not include — so prefer 'add'/'remove', and call "
            "`get` first whenever you do use it. "
            "Changes to model and budget take effect on your NEXT cycle, not this one.\n"
            "Every change EXCEPT `get` requires a `reason`: one sentence saying why. It is "
            "recorded in your owner's history alongside the before/after, and it is what "
            "lets them tell a deliberate change from an accident without reading your whole "
            "transcript. Write the actual reason, not a restatement of the action."
        )

    @property
    def parameters(self) -> dict[str, Any]:
        return {
            "type": "object",
            "properties": {
                "action": {
                    "type": "string",
                    "enum": [
                        "get", "schedule", "run_once", "cancel_run", "model", "budget", "status",
                        "identity", "workspace", "tracker", "rename", "tools", "credentials", "runtime",
                        "settings", "approvals",
                    ],
                    "description": "What to do.",
                },
                "schedule": {
                    "type": "array",
                    "description": (
                        "For action=schedule. The entries to add, remove or set, depending on `op`. "
                        "With the default op='set' this is the COMPLETE list and replaces whatever "
                        "is there now. Each entry: {type, interval, enabled, name, instruction, timezone}. "
                        "type is the kind of run and is optional (default 'work', right for almost "
                        "every job; others: self_improve, checkin, lead_search). It is NOT the schedule "
                        "type. interval is a duration ('30m', '1 hour', '7d'), a 5-field cron "
                        "expression ('0 9 * * 1-5'), or 'manual'. "
                        "name identifies the timer ('9 AM report'); with op='add' an entry whose name "
                        "matches an existing timer UPDATES it, otherwise it is added. instruction is "
                        "what you will be told to do when it fires — write it for a future you with no "
                        "memory of this chat. timezone is an IANA zone ('Asia/Kolkata'); the cron is "
                        "read in it. Without one the cron is UTC. To remove, pass the name (or id)."
                    ),
                    "items": {
                        "type": "object",
                        "properties": {
                            "type":        {"type": "string"},
                            "interval":    {"type": "string"},
                            "enabled":     {"type": "boolean"},
                            "id":          {"type": "string"},
                            "name":        {"type": "string"},
                            "instruction": {"type": "string"},
                            "timezone":    {"type": "string"},
                        },
                        "required": ["interval"],
                    },
                },
                "trigger_mode": {
                    "type": "string",
                    "enum": ["scheduled", "on_demand", "event_driven"],
                    "description": (
                        "For action=schedule. 'scheduled' runs your schedule; 'on_demand' runs only "
                        "when someone messages you. Switching away from 'scheduled' DISABLES your "
                        "entries rather than deleting them, so switching back restores them."
                    ),
                },
                "at": {
                    "type": "string",
                    "description": (
                        "For action=run_once. ISO 8601 instant WITH a UTC offset, e.g. "
                        "'2026-08-22T13:00:00+05:30'. Must be in the future. Always include the "
                        "offset — without one the time is ambiguous and will be rejected or wrong."
                    ),
                },
                "cycle_type": {
                    "type": "string",
                    "description": "For action=run_once. Defaults to 'custom'.",
                },
                "instruction": {
                    "type": "string",
                    "description": (
                        "For action=run_once. What you should do when you wake up. Write it for a "
                        "future you with no memory of this conversation — say what to do and to whom."
                    ),
                },
                "reason": {
                    "type": "string",
                    "description": (
                        "Required for every action except `get`. One sentence on WHY you are making "
                        "this change — it goes into your owner's config history next to the diff."
                    ),
                },
                "op": {
                    "type": "string",
                    "enum": ["set", "add", "remove"],
                    "description": "For action=schedule. Defaults to 'set', which REPLACES the whole list.",
                },
                "goals": {"type": "string", "description": "For action=identity. Your mission, rewritten."},
                "role": {"type": "string", "description": "For action=identity. Your job title."},
                "personality": {"type": "object", "description": "For action=identity. {voice, expertise[], style}."},
                "prompt_section": {
                    "type": "object",
                    "description": (
                        "For action=identity. Replace ONE named section of your system prompt: "
                        "{section: 'Sources', content: '...'}. The LEARNED section is not editable "
                        "this way — your self_improve cycles own it."
                    ),
                    "properties": {"section": {"type": "string"}, "content": {"type": "string"}},
                },
                "pins": {
                    "type": "array", "items": {"type": "string"},
                    "description": "For action=workspace. Workspace-relative files pinned into every cycle. Each must exist.",
                },
                "dirs": {
                    "type": "array", "items": {"type": "object", "properties": {"name": {"type": "string"}}},
                    "description": "For action=workspace. Folders to provision under your workspace.",
                },
                "schema": {"type": "object", "description": "For action=tracker. {name, stages[], fields[]}."},
                "name": {"type": "string", "description": "For action=rename. Your new name."},
                "add": {
                    "type": "array", "items": {"type": "string"},
                    "description": "For action=tools. Tool names to grant yourself.",
                },
                "remove": {
                    "type": "array", "items": {"type": "string"},
                    "description": "For action=tools. Tool names to drop.",
                },
                "op_credentials": {
                    "type": "string",
                    "enum": ["list", "request", "revoke"],
                    "description": "For action=credentials. Defaults to 'list'.",
                },
                "service": {
                    "type": "string",
                    "description": "For action=credentials with request/revoke. e.g. 'apollo', 'firecrawl'.",
                },
                "compaction_threshold_tokens": {
                    "type": "integer",
                    "description": (
                        "For action=runtime. When your context gets compacted (20000-400000). "
                        "Raise it if you keep losing the thread mid-task; lower it if you run out "
                        "of window."
                    ),
                },
                "compaction_keep_tail": {
                    "type": "integer",
                    "description": "For action=runtime. How many recent messages survive compaction verbatim (2-40).",
                },
                "disable_tools": {
                    "type": "array", "items": {"type": "string"},
                    "description": (
                        "For action=runtime. Tools to stop offering YOURSELF — useful when you keep "
                        "reaching for one that does not work for your task."
                    ),
                },
                "run_id": {"type": "string", "description": "For action=cancel_run. The id from run_once."},
                "model": {"type": "string", "description": "For action=model. Must be one the platform is configured for; `get` lists them on error."},
                "subagent_model": {"type": "string", "description": "For action=model. Model used by subagents you spawn."},
                "thinking": {"type": "boolean", "description": "For action=model. Enable extended thinking."},
                "task_models": {
                    "type": "object",
                    "description": (
                        "For action=model. Per-task model overrides, e.g. {'lead_search': "
                        "'deepseek/deepseek-v4-flash'}. null for a task removes its override."
                    ),
                },
                "op_approvals": {
                    "type": "string", "enum": ["list", "add", "remove"],
                    "description": "For action=approvals. Defaults to 'list'.",
                },
                "rule": {
                    "type": "object",
                    "description": (
                        "For action=approvals with op='add'. {action, decision, match?, note?}. "
                        "action: email, batch_send, browser_step, create_agent, budget_raise, "
                        "tool_grant, identity_rewrite, tracker_stage_delete, sweep_gate_off, "
                        "reach_setting. decision: 'auto' (do it without asking) or 'ask'. "
                        "match narrows it: {recipient: 'owner' | an address | '@domain.com'} for "
                        "email, {site: 'linkedin.com'} for browser_step."
                    ),
                },
                "rule_id": {"type": "string", "description": "For action=approvals with op='remove'."},
                "icp": {"type": "string", "description": "For action=settings. Your ideal customer profile, as text. Empty clears it."},
                "escalation_rules": {
                    "type": "array", "items": {"type": "string"},
                    "description": "For action=settings. When to stop and ask your owner. Replaces the list.",
                },
                "wake_policy": {
                    "type": "object",
                    "description": (
                        "For action=settings. What besides your timers may start you: {source: true|false} "
                        "for handoff, webhook, ask, followup, pipeline, task_packet, swarm, job, recovery."
                    ),
                },
                "whatsapp_notifications": {"type": "boolean", "description": "For action=settings."},
                "job_summary": {"type": "boolean", "description": "For action=settings. Send a summary when a background job finishes."},
                "use_user_browser": {"type": "boolean", "description": "For action=settings. Use your owner's logged-in browser. Turning on needs approval."},
                "webhook_url": {"type": "string", "description": "For action=settings. Where to post your cycle events. Setting one needs approval."},
                "daily":   {"type": "number", "description": "For action=budget. Daily spend cap in USD."},
                "monthly": {"type": "number", "description": "For action=budget. Monthly spend cap in USD."},
                "on_exhaust": {
                    "type": "string",
                    "enum": ["pause", "alert"],
                    "description": "For action=budget. What happens when the daily cap is hit.",
                },
                "status": {
                    "type": "string",
                    "enum": ["running", "paused", "stopped"],
                    "description": (
                        "For action=status. Leave it out to just CHECK whether you are on. "
                        "'running' arms your scheduled cycles — the response "
                        "tells you exactly what you armed and when it next fires, so read it: if "
                        "you only meant to run once, you want run_once instead. 'paused' stops "
                        "them and you can undo it. 'stopped' also stops them and you CANNOT undo "
                        "it — only your owner can start you again."
                    ),
                },
            },
            "required": ["action"],
        }

    async def execute(self, action: str, **kwargs: Any) -> str:
        try:
            import httpx
        except ImportError:
            return json.dumps({"error": "httpx not installed"})

        agent_id = os.environ.get("AGENT_ID", "")
        host     = os.environ.get("NanoCrew_HOST", "http://host.docker.internal:3002")
        token    = os.environ.get("NANOCREW_CYCLE_TOKEN", "")

        if not agent_id:
            return json.dumps({"error": "AGENT_ID not set — self_manage requires nanocrew context"})
        if not token:
            return json.dumps({
                "error": "No cycle token available. Self-management is only possible from inside a "
                         "NanoCrew cycle on a current orchestrator build."
            })

        base    = f"{host}/api/agents/{agent_id}/self"
        headers = {"Authorization": f"Bearer {token}"}

        # A mutating call with no stated reason is refused here rather than server-side, so
        # the model gets the correction on the same turn and can retry immediately.
        reason = str(kwargs.get("reason") or "").strip()
        read_only = (
            action == "get"
            or (action == "approvals" and (kwargs.get("op_approvals") or "list") == "list")
            # status with no value = "am I on?" — a read, answered by the server.
            or (action == "status" and not kwargs.get("status"))
        )
        if not read_only and not reason:
            return json.dumps({
                "error": f"action={action} needs a `reason` — one sentence on why you are making "
                         "this change. It is recorded in your owner's config history.",
            })

        method, url, body = "GET", base, None

        if action == "get":
            pass
        elif action == "schedule":
            body = {}
            if kwargs.get("schedule") is not None:
                body["schedule"] = [
                    {
                        # The kind of run. Optional: timers now carry their own instruction,
                        # so 'work' fits almost every job. Models also put the SCHEDULE type
                        # here ("interval", "cron") — treat anything unknown as 'work' rather
                        # than refuse the whole call over a field that barely matters.
                        "type": _cycle_type(e.get("type") or e.get("cycle_type")),
                        "interval": e.get("interval"),
                        # Default to enabled: an entry the agent just asked for and did not
                        # explicitly disable is meant to run. Omitting it would write
                        # enabled=undefined, which register() filters out — the entry would
                        # appear in the config and never fire.
                        "enabled": bool(e.get("enabled", True)),
                        # Only what was given: on op='add' an omitted field keeps its value.
                        **{k: e[k] for k in ("id", "name", "instruction", "timezone") if e.get(k)},
                    }
                    for e in kwargs["schedule"]
                ]
            if kwargs.get("trigger_mode"):
                body["triggerMode"] = kwargs["trigger_mode"]
            if kwargs.get("op"):
                body["op"] = kwargs["op"]
            method, url = "POST", f"{base}/schedule"
        elif action == "run_once":
            body = {
                "at": kwargs.get("at"),
                "cycleType": kwargs.get("cycle_type", "custom"),
                "instruction": kwargs.get("instruction", ""),
            }
            method, url = "POST", f"{base}/one-off"
        elif action == "cancel_run":
            run_id = kwargs.get("run_id")
            if not run_id:
                return json.dumps({"error": "run_id is required for cancel_run"})
            method, url = "DELETE", f"{base}/one-off/{run_id}"
        elif action == "model":
            body = {k: v for k, v in (
                ("model", kwargs.get("model")),
                ("subagentModel", kwargs.get("subagent_model")),
                ("thinking", kwargs.get("thinking")),
                ("taskModels", kwargs.get("task_models")),
            ) if v is not None}
            method, url = "POST", f"{base}/model"
        elif action == "budget":
            body = {k: v for k, v in (
                ("daily", kwargs.get("daily")),
                ("monthly", kwargs.get("monthly")),
                ("onExhaust", kwargs.get("on_exhaust")),
            ) if v is not None}
            method, url = "POST", f"{base}/budget"
        elif action == "status":
            body = {"status": kwargs.get("status")}
            method, url = "POST", f"{base}/status"
        elif action == "identity":
            body = {k: v for k, v in (
                ("goals", kwargs.get("goals")),
                ("role", kwargs.get("role")),
                ("personality", kwargs.get("personality")),
                ("promptSection", kwargs.get("prompt_section")),
            ) if v is not None}
            method, url = "POST", f"{base}/identity"
        elif action == "workspace":
            body = {k: v for k, v in (
                ("pins", kwargs.get("pins")),
                ("dirs", kwargs.get("dirs")),
            ) if v is not None}
            method, url = "POST", f"{base}/workspace"
        elif action == "tracker":
            body = {"schema": kwargs.get("schema")}
            method, url = "POST", f"{base}/tracker"
        elif action == "rename":
            body = {"name": kwargs.get("name")}
            method, url = "POST", f"{base}/rename"
        elif action == "tools":
            body = {k: v for k, v in (
                ("add", kwargs.get("add")),
                ("remove", kwargs.get("remove")),
            ) if v is not None}
            method, url = "POST", f"{base}/tools"
        elif action == "runtime":
            body = {k: v for k, v in (
                ("compactionThresholdTokens", kwargs.get("compaction_threshold_tokens")),
                ("compactionKeepTail", kwargs.get("compaction_keep_tail")),
                ("disableTools", kwargs.get("disable_tools")),
            ) if v is not None}
            method, url = "POST", f"{base}/runtime"
        elif action == "settings":
            body = {k: v for k, v in (
                ("icp", kwargs.get("icp")),
                ("escalationRules", kwargs.get("escalation_rules")),
                ("wakePolicy", kwargs.get("wake_policy")),
                ("whatsappNotifications", kwargs.get("whatsapp_notifications")),
                ("jobSummary", kwargs.get("job_summary")),
                ("useUserBrowser", kwargs.get("use_user_browser")),
                ("webhookUrl", kwargs.get("webhook_url")),
            ) if v is not None}
            method, url = "POST", f"{base}/settings"
        elif action == "approvals":
            body = {"op": kwargs.get("op_approvals") or "list"}
            if kwargs.get("rule") is not None:
                body["rule"] = kwargs["rule"]
            if kwargs.get("rule_id"):
                body["ruleId"] = kwargs["rule_id"]
            method, url = "POST", f"{base}/approvals"
        elif action == "credentials":
            body = {"op": kwargs.get("op_credentials") or "list"}
            if kwargs.get("service"):
                body["service"] = kwargs["service"]
            method, url = "POST", f"{base}/credentials"
        else:
            return json.dumps({"error": f"Unknown action: {action}"})

        # cancel_run is a DELETE and builds no body, so without this its reason would be
        # the one change that reaches the history unexplained.
        if reason and action != "get":
            body = {**(body or {}), "reason": reason}

        try:
            async with httpx.AsyncClient() as client:
                resp = await client.request(method, url, json=body, headers=headers, timeout=15)
        except Exception as exc:
            return json.dumps({"error": f"Could not reach the orchestrator: {exc}"})

        try:
            data = resp.json()
        except Exception:
            return json.dumps({"error": f"HTTP {resp.status_code}", "body": resp.text[:400]})

        # Surface the server's own message on rejection. These are written to be actionable
        # ("Cannot parse interval ... use a duration/weekday/cron") so the agent can correct
        # itself on the next turn rather than retrying the identical call.
        if resp.status_code >= 400:
            return json.dumps({"ok": False, "status": resp.status_code, **data})

        return json.dumps(data)
