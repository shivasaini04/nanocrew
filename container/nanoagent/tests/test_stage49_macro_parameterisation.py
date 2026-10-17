"""Stage 49 — a macro must not freeze the data one run happened to use.

Found live 2026-09-02. `macro_axoncrew_com_aea37c53`, distilled from a contact-form run,
stored four literals: the message, the email the owner had supplied, and two the agent
invented on the spot — `John Doe` in "Your name" and `Paper Sorting Inc` in "Company
name". It replayed them at `turns_executed: 0` with `success_count: 2`, reporting
success each time. The very first run of that task had invented an email as well; had
that run been distilled, every later replay would have typed the invented address
faithfully, forever, and each replay would have looked like a clean cached success.

The rule is about **who chose the value**, not about whether it is data:

- named in the goal → the caller's, and a macro only ever replays for that same goal,
  so freezing it changes nothing and the fast path stays free;
- absent from the goal → the model's own, inferred or invented to get past a required
  field. It becomes a parameter and the recorded value is dropped rather than kept as a
  default, because a default is just a literal that fires when nobody is looking.

A replay that cannot fill a parameter does not run; the ReAct loop takes over and
decides the value, which is the correct cost.
"""

from __future__ import annotations

import pytest

from nanoagent.agent.effector.synthesis.macro_distiller import (
    MACRO_SCHEMA_VERSION,
    MacroAction,
    MacroWorkflow,
    distill_macro_from_action_log,
)


def _typed(step: int, name: str, text: str, selector: str | None = None) -> dict:
    return {
        "step": step,
        "action": {"type": "type", "target": f"@e{step}", "text": text, "credential_ref": None},
        "result": {
            "status": "success",
            "resolved_target": {"selector": selector or f'input[name="{name}"]', "name": name, "role": "input"},
        },
    }


def _clicked(step: int, name: str) -> dict:
    return {
        "step": step,
        "action": {"type": "click", "target": f"@e{step}", "text": None, "credential_ref": None},
        "result": {
            "status": "success",
            "resolved_target": {"selector": "button.submit", "name": name, "role": "button"},
        },
    }


def _contact_form_run() -> list[dict]:
    """The shape of the run that produced the bug."""
    return [
        _typed(1, "Your name", "John Doe"),
        _typed(2, "you@company.com", "you@example.com"),
        _typed(3, "Company name", "Paper Sorting Inc"),
        _clicked(4, "Send it"),
    ]


# ─── the bug ──────────────────────────────────────────────────────────────────

def test_a_value_the_model_invented_is_never_frozen():
    """The headline. The goal named the email and nothing else; `John Doe` and
    `Paper Sorting Inc` were the model's own inventions and became permanent."""
    macro = distill_macro_from_action_log(
        goal="fill the contact form, use email you@example.com",
        domain="example.com", action_entries=_contact_form_run(),
    )
    frozen = [a.literal_value for a in macro.actions if a.literal_value is not None]
    assert "John Doe" not in frozen
    assert "Paper Sorting Inc" not in frozen


def test_a_value_the_caller_specified_stays_a_literal():
    """The other half, and why this is a rule about authorship rather than about data.
    The goal names this email, and a macro only replays for that same goal — so freezing
    it changes nothing and keeps the fast path free."""
    macro = distill_macro_from_action_log(
        goal="fill the contact form, use email you@example.com",
        domain="example.com", action_entries=_contact_form_run(),
    )
    email_step = [a for a in macro.actions if a.target_name == "you@company.com"][0]
    assert email_step.literal_value == "you@example.com"
    assert email_step.param_key is None


def test_only_the_invented_fields_become_parameters():
    macro = distill_macro_from_action_log(
        goal="fill the contact form, use email you@example.com",
        domain="example.com", action_entries=_contact_form_run(),
    )
    assert macro.parameters == ["your_name", "company_name"]


def test_the_click_is_still_a_literal_step():
    """Only DATA is parameterised. The procedure — which button, in what order — is
    exactly what a macro is for and must survive."""
    macro = distill_macro_from_action_log(
        goal="fill the contact form", domain="example.com", action_entries=_contact_form_run(),
    )
    click = [a for a in macro.actions if a.action == "click"]
    assert len(click) == 1
    assert click[0].param_key is None
    assert click[0].target == "button.submit"


def test_two_fields_with_the_same_name_get_distinct_parameters():
    """Otherwise the second field would silently take the first's value on replay."""
    macro = distill_macro_from_action_log(
        goal="g", domain="d.com",
        action_entries=[_typed(1, "Email", "a@x.com"), _typed(2, "Email", "b@x.com")],
    )
    keys = [a.param_key for a in macro.actions]
    assert len(set(keys)) == 2, keys
    assert len(macro.parameters) == 2


def test_a_field_with_no_accessible_name_still_gets_a_parameter():
    entry = _typed(1, "", "some value")
    entry["result"]["resolved_target"]["name"] = None
    macro = distill_macro_from_action_log(goal="g", domain="d.com", action_entries=[entry])
    assert macro.actions[0].param_key
    assert macro.actions[0].literal_value is None


# ─── what must not regress ────────────────────────────────────────────────────

def test_a_credential_step_still_carries_the_ref_and_not_a_value():
    entry = _typed(1, "Password", "[CREDENTIAL_REDACTED]")
    entry["action"]["credential_ref"] = "linkedin:password"
    macro = distill_macro_from_action_log(goal="log in", domain="linkedin.com", action_entries=[entry])
    action = macro.actions[0]
    assert action.credential_ref == "linkedin:password"
    assert action.literal_value is None
    # A credential resolves from the vault on replay; it must not also demand a parameter.
    assert action.param_key is None


def test_explicitly_named_parameters_still_win():
    """The caller-supplied path predates this change and must keep its own naming."""
    macro = distill_macro_from_action_log(
        goal="g", domain="d.com",
        action_entries=[_typed(1, "Your name", "John Doe")],
        parameter_values={"full_name": "John Doe"},
    )
    assert macro.actions[0].param_key == "full_name"
    assert macro.actions[0].literal_value is None
    assert macro.parameters == ["full_name"]


# ─── replay refuses rather than typing nothing ────────────────────────────────

@pytest.mark.asyncio
async def test_replay_refuses_when_a_parameter_is_missing():
    """Before this, a parameterised step with no value fell through to `literal_value`
    — None — and typed an empty string into a real form while reporting success."""
    from nanoagent.agent.effector.synthesis.macro_runner import execute_macro

    macro = MacroWorkflow(
        workflow_id="w", domain="d.com", goal="g", goal_hash="h",
        parameters=["your_name"],
        actions=[MacroAction(
            step_index=1, action="type", target='input[name="Your name"]',
            param_key="your_name", literal_value=None, target_name="Your name",
        )],
    )

    class FakePage:
        url = "https://d.com/form"

    result = await execute_macro(macro, FakePage(), parameters={})

    assert result.status != "success"
    assert "your_name" in result.message


# ─── macros already on disk ───────────────────────────────────────────────────

def test_a_newly_distilled_macro_carries_the_current_schema_version():
    macro = distill_macro_from_action_log(
        goal="g", domain="d.com", action_entries=[_typed(1, "Your name", "John Doe")],
    )
    assert macro.version == MACRO_SCHEMA_VERSION


def test_a_legacy_macro_on_disk_is_read_back_as_version_1():
    """The gap this closes: a macro distilled before the rule existed keeps its frozen
    literals AND an empty `parameters` list, so a missing-parameter check finds nothing
    to complain about and replays the baked-in values exactly as before. Shipping the
    fix would have changed nothing for every macro already written. The version is what
    lets the replay gate refuse them."""
    legacy = MacroWorkflow.from_dict({
        "workflow_id": "macro_axoncrew_com_aea37c53",
        "domain": "example.com", "goal": "fill the contact form", "goal_hash": "h",
        "parameters": [],
        "actions": [{
            "step_index": 1, "action": "type", "target": 'input[name="Your name"]',
            "param_key": None, "literal_value": "John Doe", "assertions": [],
        }],
        # No "version" key at all — exactly what the files written before this look like.
    })
    assert legacy.version == 1
    assert legacy.version < MACRO_SCHEMA_VERSION, "the gate must be able to tell it apart"
    # And the reason it must be refused rather than trusted:
    assert legacy.actions[0].literal_value == "John Doe"
    assert legacy.parameters == []
