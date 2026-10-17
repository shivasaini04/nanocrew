"""Stage 50 — the agent is told it can use a stored credential.

Everything needed to fill a password without ever seeing it already existed:
`credential_inject.resolve_credential_ref` looks it up at execution time,
`Step.from_dict` carries `credential_ref` through from the model's JSON, `executor.py`
resolves it, and `action_log.py` writes [CREDENTIAL_REDACTED] instead of the value.

One thing was missing, and it was the one that mattered: `credential_ref` appeared
NOWHERE in react_loop.py, so the model driving the loop was never told the capability
existed. Faced with a login it did the only thing it knew about — ask a human. Working
machinery nothing can reach is the failure this repo keeps paying for, so these tests
pin the reachability rather than the plumbing.
"""

from __future__ import annotations

import pytest

from nanoagent.agent.effector import react_loop as rl
from nanoagent.agent.effector.types import Step


# ─── the model has to be told ─────────────────────────────────────────────────

def test_the_action_schema_offers_credential_ref():
    """It has to be in the JSON shape the model copies, not only in prose — the schema
    line is what it actually fills in."""
    assert '"credential_ref"' in rl._SYSTEM_PROMPT


def test_the_prompt_shows_the_service_field_form():
    """A capability described without its syntax gets guessed at."""
    prompt = rl._SYSTEM_PROMPT
    assert "service:field" in prompt
    assert ":password" in prompt


def test_two_factor_is_reachable_the_same_way():
    """TOTP generation exists (credentials/totp_engine.py) and is worth nothing if the
    model does not know a 2FA box is fillable rather than a wall."""
    assert "totp" in rl._SYSTEM_PROMPT.lower()


def test_the_model_is_told_the_value_is_hidden_from_it():
    """Two reasons it must know: it should not try to read the secret back, and it must
    not put a real one in `text`, which IS logged."""
    prompt = rl._SYSTEM_PROMPT
    assert "REDACTED" in prompt.upper()


def test_the_model_is_told_not_to_guess_a_password():
    prompt = rl._SYSTEM_PROMPT.lower()
    assert "guess" in prompt


def test_a_missing_credential_points_at_takeover_not_at_stopping():
    """The ordering the prompt has to establish: try the credential, and if there is
    none, ask a person. Either half alone is a worse agent — one that guesses, or one
    that asks for hands it did not need."""
    prompt = rl._SYSTEM_PROMPT
    assert "takeover" in prompt
    # The takeover section must still name a missing credential as a reason to ask.
    assert "credential" in prompt


# ─── the JSON the model produces still reaches the executor ───────────────────

def test_a_credential_ref_survives_the_model_json():
    """`Step.from_dict` is the boundary between the model's JSON and the executor. A
    prompt that offers the field is useless if this drops it."""
    step = Step.from_dict({
        "step": 1, "action": "type", "target": "@e4",
        "credential_ref": "axoncrew:password",
    })
    assert step.credential_ref == "axoncrew:password"
    assert step.text is None, "the secret must not be carried as text"


def test_the_camelcase_spelling_is_accepted_too():
    """Models produce both; neither should silently vanish."""
    step = Step.from_dict({"step": 1, "action": "type", "credentialRef": "svc:username"})
    assert step.credential_ref == "svc:username"


def test_a_step_with_neither_text_nor_credential_is_still_invalid():
    step = Step.from_dict({"step": 1, "action": "type", "target": "@e1"})
    assert step.credential_ref is None and step.text is None


# ─── the secret must not reach the log ────────────────────────────────────────

def test_the_action_log_redacts_the_resolved_secret():
    """The point of resolving at execution time is that the plaintext exists for one
    instant in one place. credential_inject mutates the in-memory Step to carry it, so
    this redaction is the only thing between a real password and a persisted log line."""
    from nanoagent.agent.effector.action_log import build_log_entry
    from nanoagent.agent.effector.types import StepResult

    step = Step(step=1, action="type", target="@e4", text="hunter2",
                credential_ref="axoncrew:password")
    entry = build_log_entry(step, StepResult(step=1, status="success"), "run-1", "agent-1")

    assert entry.action["text"] == "[CREDENTIAL_REDACTED]"
    assert "hunter2" not in str(entry.action)
    # The vault KEY is kept on purpose: a distilled macro re-resolves it on replay.
    assert entry.action["credential_ref"] == "axoncrew:password"


@pytest.mark.asyncio
async def test_a_missing_credential_tells_the_model_what_to_do_instead(monkeypatch):
    """The failure text is read by the MODEL, which cannot store a credential itself.
    It used to say "store it first via the credentials vault" — an instruction only a
    human can follow, which leaves the loop at a dead end with no next move."""
    from nanoagent.agent.effector import executor as ex
    from nanoagent.agent.effector import credential_inject

    async def nothing_stored(_ref):
        return None

    monkeypatch.setattr(credential_inject, "resolve_credential_ref", nothing_stored)

    class _Page:
        """Only what execute_step touches before the credential branch."""
        url = "https://example.test/login"

    step = Step(step=1, action="type", target="@e1", credential_ref="nope:password")
    # execute_step never raises — a failure comes back as a StepResult.
    result = await ex.execute_step(step, page=_Page())

    assert result.status == "failed"
    assert "takeover" in (result.error or "").lower(), "a dead end must name the way out"
    assert "guess" in (result.error or "").lower()
