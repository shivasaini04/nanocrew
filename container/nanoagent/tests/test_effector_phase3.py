"""Phase 3 (domain capabilities + desktop + blueprints) reachability tests for
Effector — stage43 doc 03. Same discipline as prior phases: real code paths, not
just isolated-function unit tests where a real path is reachable."""

from __future__ import annotations

import json
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from nanoagent.agent.effector.capabilities.drag_and_drop import dispatch_drag_and_drop_file
from nanoagent.agent.effector.capabilities.financial_extractor import (
    InvoiceLineItem,
    parse_invoice_text_with_invariants,
    reconcile_invoice_arithmetic,
)
from nanoagent.agent.effector.capabilities.form_filler import answer_screening_question, smart_fill_form
from nanoagent.agent.effector.capabilities.multi_source_scraper import (
    EnrichmentProvider,
    ScrapedEntity,
    cascade_enrich_entity,
    classify_title,
    extract_structured_data_from_html,
    filter_honeypots,
    is_valid_business_email,
    normalize_company_name,
    string_similarity,
    ScraperDOMElement,
)
from nanoagent.agent.effector.capabilities.tab_manager import TabManager
from nanoagent.agent.effector.capabilities.virtual_list import scroll_and_accumulate_virtual_list
from nanoagent.agent.effector.desktop.xvfb_session import ensure_virtual_display, stop_virtual_display
from nanoagent.agent.effector.blueprints.b2b_lead_enricher import LeadEnricherConfig, run_b2b_lead_enricher
from nanoagent.agent.effector.blueprints.linkedin_job_applier import LinkedInApplierConfig, run_linkedin_job_applier
from nanoagent.agent.effector.blueprints.runner import BlueprintContext, offer_to_save_as_skill
from nanoagent.agent.tools.effector_workflow import EffectorWorkflowTool

from test_effector_phase0 import FakeKeyboard, FakeLocator, FakeMouse, FakeSession, ScriptedProvider


# ─── form_filler ──────────────────────────────────────────────────────────────

def test_answer_screening_question_handles_the_standard_categories():
    ctx = {"work_authorized": True, "requires_sponsorship": False, "total_experience_years": 7}
    assert answer_screening_question("Are you legally authorized to work in the US?", ctx) is True
    assert answer_screening_question("Do you now or in the future require visa sponsorship?", ctx) is False
    assert answer_screening_question("How many years of experience do you have?", ctx) == "7"
    assert answer_screening_question("What is your desired salary?", ctx) == "$160,000"  # no key set — default


def test_answer_screening_question_returns_none_when_nothing_matches():
    assert answer_screening_question("What's your favorite color?", {}) is None


class FakePageForForm:
    def __init__(self, elements):
        self._elements = elements
        self.actions = []
        self.url = "https://example.test/apply"
        self.viewport_size = {"width": 1280, "height": 720}
        self.mouse = FakeMouse(self)
        self.keyboard = FakeKeyboard(self)

    async def title(self):
        return "Apply"

    async def evaluate(self, script, arg=None):
        if "MutationObserver" in script:
            return True
        if 'role="listbox"' in script:
            # Checked before "querySelectorAll" below — executor.py's
            # _LISTBOX_OPEN_JS (the type-action dropdown-open check) also
            # contains that substring and would otherwise match the DOM-snapshot
            # branch, returning self._elements (truthy) for every type action.
            return False
        if "querySelectorAll" in script:
            return self._elements
        return None

    async def wait_for_timeout(self, ms):
        pass

    def locator(self, selector):
        return FakeLocator(self, selector, matched=(selector in [e["selector"] for e in self._elements]))

    def get_by_text(self, *a, **kw):
        return FakeLocator(self, "x", matched=False)

    def get_by_role(self, *a, **kw):
        return FakeLocator(self, "x", matched=False)

    def get_by_label(self, *a, **kw):
        return FakeLocator(self, "x", matched=False)

    def get_by_placeholder(self, *a, **kw):
        return FakeLocator(self, "x", matched=False)


@pytest.mark.asyncio
async def test_smart_fill_form_matches_fields_by_semantic_name_not_exact_selector():
    page = FakePageForForm([
        {"tag": "input", "role": "textbox", "name": "Full Name", "type": "text", "selector": "#full_name",
         "bounds": {"x": 0, "y": 0, "width": 100, "height": 20}, "center": {"x": 50, "y": 10}, "isEnabled": True},
        {"tag": "button", "role": "button", "name": "Submit Application", "selector": "#submit",
         "bounds": {"x": 0, "y": 40, "width": 100, "height": 20}, "center": {"x": 50, "y": 50}, "isEnabled": True},
    ])

    result = await smart_fill_form(page, {"fullName": "Ada Lovelace"}, auto_submit=True)

    assert "fullName" in result.filled_fields
    assert result.is_complete
    # execute_step here gets no ExecutorOptions (same as the TS original), so typing
    # defaults to the human-cadence char-by-char path — see the effector_workflow
    # smart-form test below for the full explanation.
    typed_chars = [a[1] for a in page.actions if a[0] == "kb_type"]
    assert "".join(typed_chars) == "Ada Lovelace"
    assert ("click", "#submit") in page.actions


@pytest.mark.asyncio
async def test_smart_fill_form_skips_unmatched_fields_instead_of_erroring():
    page = FakePageForForm([])
    result = await smart_fill_form(page, {"nonexistentField": "x"})
    assert result.skipped_fields == ["nonexistentField"]
    assert result.filled_fields == []


# ─── financial_extractor ─────────────────────────────────────────────────────

def test_reconcile_invoice_arithmetic_flags_a_balanced_invoice():
    record = reconcile_invoice_arithmetic(
        invoice_number="INV-001", vendor_name="Acme Corp",
        line_items=[InvoiceLineItem(description="Widget", quantity=2, unit_price=50.0, total=100.0)],
        subtotal=100.0, tax_amount=8.0, total_amount=108.0,
    )
    assert record.is_mathematically_balanced is True
    assert record.balance_discrepancy == 0.0
    assert record.confidence_score > 0.5


def test_reconcile_invoice_arithmetic_flags_a_mismatched_invoice():
    record = reconcile_invoice_arithmetic(subtotal=100.0, tax_amount=8.0, total_amount=200.0)
    assert record.is_mathematically_balanced is False
    assert record.balance_discrepancy == pytest.approx(92.0)


def test_parse_invoice_text_extracts_and_reconciles_from_raw_text():
    text = "Invoice #INV-2026-001\nSubtotal: $500.00\nTax: $40.00\nTotal Due: $540.00\nDate: 2026-08-20"
    record = parse_invoice_text_with_invariants(text)
    assert record.invoice_number == "INV-2026-001"
    assert record.subtotal == 500.0
    assert record.tax_amount == 40.0
    assert record.total_amount == 540.0
    assert record.is_mathematically_balanced is True


# ─── multi_source_scraper ────────────────────────────────────────────────────

def test_normalize_company_name_strips_legal_suffixes():
    # Suffix stripping is single-pass and anchored to the literal string end — once
    # "Inc." is stripped, the comma before "Technologies" means the "technologies"
    # suffix pattern no longer matches at the (new) end of string. This is the TS
    # original's actual behavior (ported faithfully), not a bug — a name with only
    # one trailing legal suffix strips cleanly, as the second assertion shows.
    assert normalize_company_name("Acme Technologies, Inc.") == "acme technologies"
    assert normalize_company_name("Beta LLC") == "beta"


def test_classify_title_identifies_seniority_and_department():
    seniority, department = classify_title("VP of Engineering")
    assert seniority == "VP"
    assert department == "Engineering"

    seniority, department = classify_title(None)
    assert seniority is None and department is None


def test_filter_honeypots_removes_zero_size_and_flagged_elements():
    elements = [
        ScraperDOMElement(bounds={"x": 0, "y": 0, "width": 100, "height": 20}, name="Email"),
        ScraperDOMElement(bounds={"x": 0, "y": 0, "width": 0, "height": 0}, name="hp_field"),
        ScraperDOMElement(bounds={"x": -5, "y": 0, "width": 10, "height": 10}, name="normal"),
        ScraperDOMElement(bounds={"x": 0, "y": 0, "width": 10, "height": 10}, name="bot_check"),
    ]
    survivors = filter_honeypots(elements)
    assert len(survivors) == 1
    assert survivors[0].name == "Email"


def test_is_valid_business_email_rejects_disposable_domains():
    assert is_valid_business_email("jane@acme.com") is True
    assert is_valid_business_email("throwaway@mailinator.com") is False
    assert is_valid_business_email("not-an-email") is False
    assert is_valid_business_email(None) is False


def test_string_similarity_identical_and_disjoint():
    assert string_similarity("Jonathan", "Jonathan") == 1.0
    assert string_similarity("Jonathan", "Jonathan") > string_similarity("Jonathan", "Zzzzzzzz")


@pytest.mark.asyncio
async def test_cascade_enrich_entity_stops_early_once_fully_confirmed():
    calls = []

    async def provider_a_enrich(entity):
        calls.append("a")
        return {"email": "jane@acme.com", "linkedin_url": "https://linkedin.com/in/jane", "title": "VP Sales"}

    async def provider_b_enrich(entity):
        calls.append("b")  # should never be reached — entity is fully confirmed after provider_a
        return {"phone": "555-1234"}

    providers = [
        EnrichmentProvider(name="provider_a", priority=10, enrich=provider_a_enrich),
        EnrichmentProvider(name="provider_b", priority=5, enrich=provider_b_enrich),
    ]

    entity = await cascade_enrich_entity({"name": "Jane Doe", "company": "Acme Inc."}, providers)

    assert entity.email == "jane@acme.com"
    assert entity.linkedin_url == "https://linkedin.com/in/jane"
    assert calls == ["a"]  # provider_b never called — early stop worked
    assert entity.confidence > 0.6  # multi-field confirmation bumped it up


def test_extract_structured_data_from_html_finds_json_ld_person():
    html = """
    <script type="application/ld+json">
    {"@type": "Person", "name": "Jane Doe", "jobTitle": "CTO", "worksFor": {"name": "Acme Inc."}, "email": "jane@acme.com"}
    </script>
    """
    results = extract_structured_data_from_html(html)
    assert len(results) == 1
    assert results[0]["name"] == "Jane Doe"
    assert results[0]["company"] == "Acme Inc."


# ─── drag_and_drop ────────────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_dispatch_drag_and_drop_file_passes_base64_and_selector_to_the_page():
    captured = {}

    class FakePageForDrop:
        async def evaluate(self, script, arg):
            captured.update(arg)
            return True

    ok = await dispatch_drag_and_drop_file(FakePageForDrop(), "#dropzone", file_buffer_base64="AAAA", file_name="doc.pdf")
    assert ok is True
    assert captured["selector"] == "#dropzone"
    assert captured["b64"] == "AAAA"
    assert captured["name"] == "doc.pdf"


@pytest.mark.asyncio
async def test_dispatch_drag_and_drop_file_fails_gracefully_with_no_source():
    class FakePageForDrop:
        async def evaluate(self, script, arg):
            return True

    ok = await dispatch_drag_and_drop_file(FakePageForDrop(), "#dropzone")
    assert ok is False


# ─── tab_manager ──────────────────────────────────────────────────────────────

def test_tab_manager_tracks_a_new_popup_and_focuses_it():
    handlers = {}

    class FakeContext:
        def __init__(self):
            self.pages = []

        def on(self, event, handler):
            handlers[event] = handler

    class FakePage:
        def __init__(self, url):
            self.url = url
            self._close_handlers = []

        def on(self, event, handler):
            self._close_handlers.append(handler)

    context = FakeContext()
    initial = FakePage("https://example.test/main")
    manager = TabManager(context, initial_page=initial)

    assert manager.get_tab_count() == 1
    assert manager.get_active_page() is initial

    popup = FakePage("https://example.test/popup")
    handlers["page"](popup)

    assert manager.get_tab_count() == 2
    assert manager.get_active_page() is popup

    for close_handler in popup._close_handlers:
        close_handler()
    assert manager.get_tab_count() == 1
    assert manager.get_active_page() is initial


# ─── virtual_list ─────────────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_scroll_and_accumulate_virtual_list_stops_after_empty_scrolls():
    call_count = {"evaluate": 0}

    class FakePageForVirtualList:
        async def evaluate(self, script, arg=None):
            call_count["evaluate"] += 1
            if "querySelectorAll" not in script and "scrollTop" not in script:
                # row extractor call — always returns the same 2 rows (nothing new after first slice)
                return [{"id": "1", "name": "Row A"}, {"id": "2", "name": "Row B"}]
            return False  # scroll call — never reaches bottom on its own

        async def wait_for_timeout(self, ms):
            pass

    result = await scroll_and_accumulate_virtual_list(
        FakePageForVirtualList(), "#list", "() => []", max_consecutive_empty_scrolls=2, settle_delay_ms=0,
    )

    assert result.total_collected == 2
    assert result.reached_end is True  # stopped via empty-scroll counter, not max iterations


# ─── desktop (Xvfb lazy start + Linux driver, mocked subprocess) ─────────────

def test_ensure_virtual_display_returns_none_when_xvfb_is_not_installed():
    stop_virtual_display()
    with patch("shutil.which", return_value=None):
        assert ensure_virtual_display() is None


def test_ensure_virtual_display_starts_xvfb_once_and_is_idempotent():
    stop_virtual_display()
    fake_proc = MagicMock()
    fake_proc.poll.return_value = None  # still running

    with patch("shutil.which", return_value="/usr/bin/Xvfb"), \
         patch("subprocess.Popen", return_value=fake_proc) as mock_popen, \
         patch("nanoagent.agent.effector.desktop.xvfb_session._wait_for_display_ready", return_value=True):
        display1 = ensure_virtual_display()
        display2 = ensure_virtual_display()

    assert display1 == display2 == ":99"
    mock_popen.assert_called_once()  # second call didn't relaunch — idempotent
    stop_virtual_display()


@pytest.mark.asyncio
async def test_desktop_vision_falls_back_to_screen_center_with_no_provider():
    from nanoagent.agent.effector.desktop.desktop_vision import ground_visual_element

    with patch(
        "nanoagent.agent.effector.desktop.desktop_vision.capture_desktop_screenshot",
        AsyncMock(return_value="fakebase64"),
    ), patch(
        "nanoagent.agent.effector.desktop.desktop_vision.get_display_metrics",
        AsyncMock(return_value=MagicMock(width=1920, height=1080)),
    ):
        result = await ground_visual_element("the save button", provider=None, vision_model=None)

    assert result.x == 960
    assert result.y == 540
    assert result.confidence == 0.5


# ─── Blueprints ───────────────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_linkedin_job_applier_builds_the_right_goal_and_starts_at_the_search_url(tmp_path: Path):
    script = [{"thought": "submitted", "action": "done", "extractedData": {}}]
    provider = ScriptedProvider(script)
    fake_session = FakeSession()

    ctx = BlueprintContext(
        page=fake_session.page, provider=provider, model="fake/decision",
        workspace=tmp_path, run_id="bp-run-1",
    )
    config = LinkedInApplierConfig(job_query="Backend Engineer", candidate_name="Ada Lovelace", candidate_email="ada@example.com")

    result = await run_linkedin_job_applier(config, ctx)

    assert result.execution.success is True
    assert fake_session.page.url == "https://www.linkedin.com/jobs/search/?keywords=Backend%20Engineer&location=Remote&f_AL=true"


@pytest.mark.asyncio
async def test_b2b_lead_enricher_surfaces_extracted_leads(tmp_path: Path):
    leads = [{"name": "Jane Doe", "title": "VP Sales", "company": "Acme"}]
    script = [{"thought": "found leads", "action": "done", "extractedData": {"leads": leads}}]
    provider = ScriptedProvider(script)
    fake_session = FakeSession()

    ctx = BlueprintContext(page=fake_session.page, provider=provider, model="fake/decision", workspace=tmp_path, run_id="bp-run-2")
    result = await run_b2b_lead_enricher(LeadEnricherConfig(icp_title="VP Sales"), ctx)

    assert result.leads_extracted == leads


@pytest.mark.asyncio
async def test_offer_to_save_as_skill_writes_a_real_skill_file_on_success(tmp_path: Path):
    from nanoagent.agent.effector.types import EffectorExecutionResult, EffectorTurnLog, Step, StepResult

    execution = EffectorExecutionResult(
        success=True, goal="test goal", turns_executed=1, final_url="https://example.test",
        turns=[EffectorTurnLog(turn=1, thought="clicked it", action=Step(step=1, action="click", target="@e1"),
                                result=StepResult(step=1, status="success"))],
    )

    msg = await offer_to_save_as_skill(tmp_path, "test-blueprint", "test goal", execution)

    assert msg is not None
    skill_file = tmp_path / "skills" / "effector-test-blueprint" / "SKILL.md"
    assert skill_file.exists()
    assert "test goal" in skill_file.read_text()


@pytest.mark.asyncio
async def test_offer_to_save_as_skill_does_nothing_on_a_failed_run(tmp_path: Path):
    from nanoagent.agent.effector.types import EffectorExecutionResult

    execution = EffectorExecutionResult(success=False, goal="x", turns_executed=0, final_url="", turns=[], error="failed")
    msg = await offer_to_save_as_skill(tmp_path, "test-blueprint", "x", execution)

    assert msg is None
    assert not (tmp_path / "skills").exists()


# ─── EffectorWorkflowTool end-to-end ──────────────────────────────────────────

@pytest.mark.asyncio
async def test_effector_workflow_tool_runs_smart_form_without_react_loop(tmp_path: Path):
    """smart-form doesn't drive react_loop at all — this proves the tool wires
    straight to form_filler.smart_fill_form for that workflow type. Uses
    FakePage's built-in fixture element (name="Name", selector="#name")."""
    fake_session = FakeSession()

    class FakeProviderNeverCalled:
        async def chat(self, *a, **kw):
            raise AssertionError("smart-form must not call the decision LLM")

        def get_default_model(self):
            return "fake/never"

    provider = FakeProviderNeverCalled()
    tool = EffectorWorkflowTool(workspace=tmp_path, provider=provider, model="fake/primary")

    with patch("nanoagent.agent.effector.browser_session.EffectorSession", return_value=fake_session):
        raw = await tool.execute(workflow_type="smart-form", fields={"name": "Ada Lovelace"})

    result = json.loads(raw)
    assert result["success"] is True
    assert "name" in result["data"]["filled_fields"]
    # form_filler's execute_step calls never receive an ExecutorOptions — same as the
    # TS original — so typing always goes through the human-cadence path regardless
    # of the tool's use_human_cadence setting. Check the char-by-char kb_type trail
    # rather than a .fill() call, which reflects that faithfully-ported behavior.
    typed_chars = [a[1] for a in fake_session.page.actions if a[0] == "kb_type"]
    assert "".join(typed_chars) == "Ada Lovelace"
