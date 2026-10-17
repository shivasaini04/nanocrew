"""Stage 62 phase 2 — the words Jev cannot write, and the ones nothing may invent.

Jev decided 23% of steps because it returns choices, never text; every typing turn fell
back to the full LLM. Pairing it with one narrow text question is how `jev-ultrafast`
covers every step. The risk that comes with it is obvious and is most of this file: a
model asked "what goes in this field" will happily answer for a password box.
"""

from __future__ import annotations

from types import SimpleNamespace

import pytest

from nanoagent.agent.effector.field_text import field_text, looks_secret
from nanoagent.agent.effector.jev_policy import build_request, page_text

SUMMARY = """Page URL: https://shop.example/checkout
Page Title: Checkout
Interactive Elements:
  [@e1] input "Search books" (center: 100,50)
  [@e2] a "Home" (center: 20,10)
  [@e3] input "Password" (center: 100,90)

Page content:
Your basket contains 2 items. Total GBP 31.40.
"""


class FakeProvider:
    def __init__(self, content: str):
        self.content = content
        self.calls: list[dict] = []

    async def chat(self, messages, model=None, max_tokens=None, temperature=None, **kw):
        self.calls.append({"messages": messages, "model": model, "kw": kw})
        return SimpleNamespace(content=self.content, usage=None)


async def ask(provider, field="Search books", goal="find a book"):
    return await field_text(
        provider, "test-model", goal=goal, field_label=field,
        page="Your basket contains 2 items.", recent_actions="",
    )


# ------------------------------------------------------------ never a credential


@pytest.mark.parametrize("label", [
    "Password", "password", "Confirm Password", "passwd", "PIN", "One-time code",
    "OTP", "2FA code", "CVV", "Security code", "Card number", "API key",
    "Secret", "Account number", "IBAN", "SSN", "Social Security Number", "Passport number",
])
def test_credential_fields_are_refused_by_name(label):
    assert looks_secret(label) is True, f"{label!r} would have been answered by a model"


@pytest.mark.parametrize("label", ["Search books", "Email", "City", "Quantity", "Message"])
def test_ordinary_fields_are_not_mistaken_for_credentials(label):
    assert looks_secret(label) is False


async def test_a_password_field_never_reaches_the_model():
    provider = FakeProvider('{"text": "hunter2"}')
    out = await ask(provider, field="Password")

    assert out.text is None
    assert provider.calls == [], "a credential field was sent to a language model"
    assert "vault" in (out.refused or "")


# ------------------------------------------------------------ the answer contract


async def test_a_clean_answer_is_used():
    out = await ask(FakeProvider('{"text": "dune"}'))
    assert out.text == "dune"


async def test_an_answer_wrapped_in_a_fence_is_still_read():
    out = await ask(FakeProvider('```json\n{"text": "dune"}\n```'))
    assert out.text == "dune", "the provider has no JSON mode, so fences are normal"


async def test_a_null_answer_hands_the_turn_back():
    out = await ask(FakeProvider('{"text": null}'))
    assert out.text is None and out.refused == "no usable value"


@pytest.mark.parametrize("content", [
    'I think you should type "dune" here.',          # prose, no object
    '{"text": "dune", "reason": "it is a book"}',    # extra keys
    '{"value": "dune"}',                             # wrong key
    '{"text": ""}',                                  # empty
    '{"text": 42}',                                  # not a string
    '',
])
async def test_anything_but_the_one_shape_is_refused(content):
    out = await ask(FakeProvider(content))
    assert out.text is None, f"{content!r} was accepted as a field value"


async def test_a_provider_error_hands_the_turn_back_rather_than_raising():
    class Boom:
        async def chat(self, *a, **k):
            raise RuntimeError("model down")

    out = await ask(Boom())
    assert out.text is None and "model down" in (out.refused or "")


async def test_the_model_is_told_never_to_invent_personal_information():
    provider = FakeProvider('{"text": "x"}')
    await ask(provider)
    system = provider.calls[0]["messages"][0]["content"]
    assert "NEVER invent personal information" in system
    assert "untrusted data" in system


# --------------------------------------------- the payload Jev is asked to read


def test_the_page_state_no_longer_repeats_the_element_table():
    """Measured 2026-09-20: the same model answered in 384 ms for us and 178 ms for
    jev-ultrafast. We were sending every control up to three times — once as the page,
    once as click_target, once as type_target."""
    text = page_text(SUMMARY)

    assert "[@e1]" not in text and "[@e3]" not in text
    assert "Interactive Elements:" not in text
    assert "Your basket contains 2 items" in text, "the page's actual text was thrown away"
    assert "Checkout" in text, "the title is context the model needs"


def test_the_request_carries_the_elements_once_as_criteria():
    body = build_request("buy a book", SUMMARY, "", "https://shop.example/checkout")

    state_blob = body["state"]["page"]
    assert "[@e1]" not in state_blob
    assert body["state"]["element_count"] == 3
    assert set(body["questions"]["click_target"]["criteria"]) == {"@e1", "@e2", "@e3"}


def test_only_typeable_fields_are_offered_as_type_targets():
    body = build_request("buy a book", SUMMARY, "", "")
    assert set(body["questions"]["type_target"]["criteria"]) == {"@e1", "@e3"}, (
        "the link @e2 was offered as somewhere to type"
    )


def test_a_page_with_no_elements_produces_no_request():
    assert build_request("goal", "Page URL: x\n\nnothing here", "", "") is None
