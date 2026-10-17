"""Ported from computer-use/form-filler.ts. Semantic label matching against a DOM
snapshot (rather than a fixed selector list) so the same fill call works across
Workday/Greenhouse/LinkedIn's differently-structured forms — the point of "smart".

Field adaptation note (same as self_healing_selectors.py): matches against
`element.name` only, since that's what Effector's dom_snapshot.py actually captures —
the TS original's `el.text` field doesn't exist here.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Any

from loguru import logger

from nanoagent.agent.effector.dom_snapshot import capture_dom_snapshot
from nanoagent.agent.effector.executor import execute_step
from nanoagent.agent.effector.types import Step


@dataclass
class FormFieldValue:
    value: Any
    type: str | None = None  # 'text' | 'select' | 'radio' | 'checkbox' | 'file'


@dataclass
class FormFillResult:
    filled_fields: list[str] = field(default_factory=list)
    skipped_fields: list[str] = field(default_factory=list)
    errors: list[dict[str, str]] = field(default_factory=list)
    is_complete: bool = True


@dataclass
class FormWizardResult:
    steps_completed: int = 0
    is_submitted: bool = False
    total_fields_filled: int = 0
    errors: list[str] = field(default_factory=list)


_SUBMIT_PATTERN = re.compile(r"submit|send|save|continue|next|apply", re.IGNORECASE)
_NEXT_PATTERN = re.compile(r"next|continue|save & continue|review", re.IGNORECASE)
_FINAL_SUBMIT_PATTERN = re.compile(r"submit|submit application|finish|complete", re.IGNORECASE)


def _normalize(s: str) -> str:
    return re.sub(r"[^a-z0-9]", "", s.lower())


def answer_screening_question(question: str, profile_context: dict[str, Any]) -> str | bool | None:
    """Answer a job-application screening question using grounded profile context."""
    q = question.lower()

    if "authorized to work" in q or "legally authorized" in q or "work authorization" in q:
        return bool(profile_context.get("work_authorized", True))
    if "require sponsorship" in q or "visa sponsorship" in q or "now or in the future" in q:
        return bool(profile_context.get("requires_sponsorship", False))

    if "years of experience" in q or "how many years" in q:
        for key, val in profile_context.items():
            if key.lower() in q:
                return str(val)
        return str(profile_context.get("total_experience_years", "5"))

    if "salary expectation" in q or "desired salary" in q or "compensation" in q:
        return str(profile_context.get("desired_salary", "$160,000"))

    if "remote" in q or "hybrid" in q or "relocate" in q:
        return bool(profile_context.get("willing_to_relocate", True))

    if "notice period" in q or "start date" in q or "how soon" in q:
        return str(profile_context.get("notice_period", "2 weeks"))

    for key, val in profile_context.items():
        if re.sub(r"[^a-z0-9]", " ", key.lower()) in q:
            return val if isinstance(val, bool) else str(val)

    return None


async def smart_fill_form(
    page,
    fields: dict[str, Any],
    auto_submit: bool = False,
    submit_button_text: str | None = None,
) -> FormFillResult:
    """Fill a form using semantic label matching against the current DOM snapshot,
    rather than hardcoded selectors — the same call works across differently-
    structured application forms."""
    snapshot = await capture_dom_snapshot(page)
    result = FormFillResult()

    for field_name, raw_value in fields.items():
        val_obj = raw_value if isinstance(raw_value, FormFieldValue) else FormFieldValue(value=raw_value)
        str_value = str(val_obj.value)
        normalized_name = _normalize(field_name)

        matched = next(
            (el for el in snapshot.elements
             if normalized_name in _normalize(el.name or "")),
            None,
        )

        if matched is None:
            result.skipped_fields.append(field_name)
            continue

        try:
            if matched.tag in ("input", "textarea"):
                is_checkbox_or_radio = matched.role in ("checkbox", "radio")
                if is_checkbox_or_radio:
                    if val_obj.value is True or str_value.lower() in ("true", "yes"):
                        await execute_step(Step(step=1, action="click", target=matched.ref), page)
                        result.filled_fields.append(field_name)
                else:
                    await execute_step(Step(step=1, action="type", target=matched.ref, text=str_value), page)
                    result.filled_fields.append(field_name)
            elif matched.tag == "select":
                await execute_step(Step(step=1, action="select", target=matched.ref, value=str_value), page)
                result.filled_fields.append(field_name)
            else:
                await execute_step(Step(step=1, action="click", target=matched.ref), page)
                result.filled_fields.append(field_name)
        except Exception as err:
            result.errors.append({"field": field_name, "error": str(err)})

    if auto_submit and result.filled_fields:
        pattern = re.compile(submit_button_text, re.IGNORECASE) if submit_button_text else _SUBMIT_PATTERN
        submit_btn = next(
            (el for el in snapshot.elements if el.tag == "button" and pattern.search(el.name or "")),
            None,
        )
        if submit_btn:
            try:
                await execute_step(Step(step=1, action="click", target=submit_btn.ref), page)
            except Exception:
                pass  # best-effort, matches TS's .catch(() => undefined)

    result.is_complete = len(result.errors) == 0
    return result


async def run_multi_step_form_wizard(
    page,
    field_values: dict[str, Any],
    max_steps: int = 5,
    submit_on_final_step: bool = True,
    screening_context: dict[str, Any] | None = None,
) -> FormWizardResult:
    """Drive a complete multi-step application wizard (Workday, Greenhouse, etc.) —
    fills known fields each step, answers open-ended screening questions if a
    profile context is given, and advances via Next/Submit until no wizard button
    remains."""
    result = FormWizardResult()

    for step_num in range(1, max_steps + 1):
        logger.info(f"effector form-filler: executing wizard step {step_num}")

        fill_result = await smart_fill_form(page, field_values)
        result.total_fields_filled += len(fill_result.filled_fields)

        if screening_context:
            snapshot = await capture_dom_snapshot(page)
            for el in snapshot.elements:
                if el.tag in ("input", "textarea") and el.name:
                    answer = answer_screening_question(el.name, screening_context)
                    if answer is not None:
                        try:
                            if isinstance(answer, bool):
                                if answer:
                                    await execute_step(Step(step=1, action="click", target=el.ref), page)
                            else:
                                await execute_step(Step(step=1, action="type", target=el.ref, text=str(answer)), page)
                            result.total_fields_filled += 1
                        except Exception:
                            pass  # best-effort, matches TS's .catch(() => undefined)

        result.steps_completed += 1

        snapshot_after = await capture_dom_snapshot(page)
        next_btn = next((el for el in snapshot_after.elements if el.tag == "button" and _NEXT_PATTERN.search(el.name or "")), None)
        submit_btn = next((el for el in snapshot_after.elements if el.tag == "button" and _FINAL_SUBMIT_PATTERN.search(el.name or "")), None)

        if next_btn:
            await execute_step(Step(step=1, action="click", target=next_btn.ref), page)
            await page.wait_for_timeout(1000)
        elif submit_btn and submit_on_final_step:
            await execute_step(Step(step=1, action="click", target=submit_btn.ref), page)
            result.is_submitted = True
            break
        else:
            break  # no more wizard buttons found

    return result
