"""Ported from computer-use/verify.ts. Runs postcondition assertions after a step so
a no-op action can't be silently reported as success — see stage 43's own citation of
reference_agent_records_are_not_evidence for why this matters."""

from __future__ import annotations

from nanoagent.agent.effector.types import VerificationResult, VerifySpec


async def run_verification(spec: VerifySpec, page) -> VerificationResult:
    failures: list[str] = []

    if spec.url_contains:
        url = page.url
        if spec.url_contains not in url:
            failures.append(f'url_contains: expected "{spec.url_contains}" in "{url}"')

    if spec.element_visible:
        try:
            locator = page.locator(spec.element_visible)
            visible = await locator.first.is_visible(timeout=3000)
        except Exception:
            visible = False
        if not visible:
            failures.append(f'element_visible: "{spec.element_visible}" not found or not visible')

    if spec.element_absent:
        try:
            locator = page.locator(spec.element_absent)
            count = await locator.count()
            if count > 0:
                visible = await locator.first.is_visible()
                if visible:
                    failures.append(f'element_absent: "{spec.element_absent}" is still visible')
        except Exception:
            failures.append(f'element_absent: error checking "{spec.element_absent}"')

    if spec.text_present:
        try:
            body_text = await page.evaluate("() => document.body ? document.body.innerText : ''")
        except Exception:
            body_text = None
        if body_text is None:
            failures.append("text_present: could not read page text")
        elif spec.text_present not in body_text:
            failures.append(f'text_present: "{spec.text_present}" not found in page')

    if failures:
        return VerificationResult(passed=False, reason="; ".join(failures))
    return VerificationResult(passed=True)
