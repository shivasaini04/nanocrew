"""stage45 gap E: getting a file OFF a page — `effector/downloads.py`.

Before this, `grep -rn download effector/**/*.py` returned nothing, and
`blueprints/invoice_receipt_extractor.py` had shipped unable to save an invoice.

What is worth testing here, and what is not. Per this repo's own test doctrine
, a passing
unit suite over browser code proves very little — the last several effector bugs of
this shape were each found by a live run and none by a test. So this file
deliberately does NOT try to prove "downloads work"; a fake Playwright object
agreeing with itself proves nothing about Chromium.

What it does pin down is the part that is pure logic and genuinely dangerous to get
wrong, where a test IS the right instrument:

  * filename sanitisation — `suggested_filename` is attacker-controlled and is used
    as a path
  * the collision reservation, including the concurrent case `effector_swarm` creates
  * the size and count caps, including that a capped file is actually removed
  * the SSRF check on `fetch_url`, which the network shield cannot see because
    APIRequestContext does not pass through `page.route`
  * that a refusal is RECORDED, with its reason, rather than looking like a download
    nobody asked for

The live half — a real Chromium, a real export button, a real PDF viewer — is listed
as unrun in the stage doc rather than simulated here.
"""

from __future__ import annotations

import asyncio
import os
from pathlib import Path

import pytest

from nanoagent.agent.effector.downloads import (
    DOWNLOADS_DIRNAME,
    DownloadManager,
    _filename_from_disposition,
    _filename_from_url,
    _reserve_path,
    looks_like_pdf_viewer,
    safe_filename,
)


# ── fakes ────────────────────────────────────────────────────────────────────


class FakeDownload:
    """Playwright's Download, reduced to the four members downloads.py touches."""

    def __init__(self, suggested: str, body: bytes = b"hello", failure: str | None = None):
        self.suggested_filename = suggested
        self.url = f"https://example.test/files/{suggested}"
        self._body = body
        self._failure = failure
        self.saved_to: str | None = None

    async def failure(self):
        return self._failure

    async def save_as(self, path: str) -> None:
        self.saved_to = path
        Path(path).write_bytes(self._body)


class FakeResponse:
    def __init__(self, status=200, body=b"pdf-bytes", headers=None, url=None):
        self.status = status
        self.headers = headers or {}
        self.url = url
        self._body = body

    async def body(self):
        return self._body


class FakeRequestContext:
    def __init__(self, response: FakeResponse):
        self._response = response
        self.requested: list[str] = []

    async def get(self, url, **_kw):
        self.requested.append(url)
        if self._response.url is None:
            self._response.url = url
        return self._response


class FakePageWithRequest:
    def __init__(self, response: FakeResponse, url="https://example.test/invoice.pdf"):
        self.url = url
        self.request = FakeRequestContext(response)


class FakeContext:
    """Just enough of a Playwright BrowserContext to register a listener."""

    def __init__(self):
        self.handlers: dict[str, list] = {}

    def on(self, event, handler):
        self.handlers.setdefault(event, []).append(handler)

    def emit(self, event, payload):
        for h in self.handlers.get(event, []):
            h(payload)


@pytest.fixture
def workspace(tmp_path: Path) -> Path:
    return tmp_path


def _files_in(workspace: Path) -> list[Path]:
    """What actually landed. Tolerates the directory not existing, which is itself the
    right behaviour on a refusal: a download refused before the request is sent should
    not leave so much as an empty `downloads/` behind."""
    d = workspace / DOWNLOADS_DIRNAME
    return sorted(d.iterdir()) if d.is_dir() else []


# ── filename sanitisation ────────────────────────────────────────────────────


@pytest.mark.parametrize(
    "hostile,expected_not",
    [
        ("../../etc/passwd", ".."),
        ("..\\..\\windows\\system32\\config", ".."),
        ("/etc/shadow", "/"),
        ("....//....//escape.pdf", "/"),
        ("..%2F..%2Fescape.pdf", "/"),
    ],
)
def test_traversal_never_survives_sanitisation(hostile, expected_not):
    """The whole point: after safe_filename there is no separator left in the string,
    so `..` cannot mean the parent of anything."""
    name = safe_filename(hostile)
    assert "/" not in name
    assert "\\" not in name
    assert not name.startswith("..")
    assert expected_not not in name or expected_not == ".."


def test_percent_encoded_separator_is_decoded_before_the_check():
    """`..%2Fescape.pdf` is `../escape.pdf` to anything that decodes it later. Decoding
    after the separator check would let it through looking clean."""
    assert safe_filename("..%2F..%2Fescape.pdf") == "escape.pdf"


def test_nul_and_control_characters_are_stripped():
    """A NUL truncates the name in any C library underneath — the name Python records
    and the name that reaches the filesystem must be the same string."""
    assert "\x00" not in safe_filename("report\x00.pdf")
    assert "\n" not in safe_filename("re\nport.pdf")


def test_dot_names_fall_back_rather_than_becoming_a_path():
    assert safe_filename("..") == "download.bin"
    assert safe_filename(".") == "download.bin"
    assert safe_filename("") == "download.bin"
    assert safe_filename(None) == "download.bin"


def test_leading_dot_is_stripped_so_the_agent_can_see_the_file():
    """A dotfile is invisible to list_dir, so the agent downloads something and then
    cannot find it."""
    assert safe_filename(".hidden.pdf") == "hidden.pdf"


def test_windows_reserved_names_are_defused():
    """The container is Linux, but a workspace gets zipped and opened on a laptop."""
    assert safe_filename("CON.pdf") == "_CON.pdf"
    assert safe_filename("lpt1.txt") == "_lpt1.txt"


def test_overlong_names_are_truncated_in_bytes_and_keep_the_extension():
    """ext4's limit is 255 BYTES. A name of 200 CJK characters is over it while 200
    ASCII ones are not, so a character-count truncation still fails with ENAMETOOLONG.
    The extension survives because it is what says what the file is."""
    name = safe_filename("あ" * 300 + ".pdf")
    assert len(name.encode("utf-8")) <= 255
    assert name.endswith(".pdf")
    # The slice must not leave a broken character behind.
    name.encode("utf-8").decode("utf-8")


def test_a_normal_name_is_left_completely_alone():
    """Sanitisation that mangles ordinary input is its own bug."""
    assert safe_filename("Invoice 2026-08 (final).pdf") == "Invoice 2026-08 (final).pdf"


# ── collision handling ───────────────────────────────────────────────────────


def test_second_file_with_the_same_name_does_not_overwrite_the_first(workspace):
    d = workspace / DOWNLOADS_DIRNAME
    d.mkdir()
    first = _reserve_path(d, "report.pdf")
    first.write_bytes(b"first")
    second = _reserve_path(d, "report.pdf")
    second.write_bytes(b"second")

    assert first.name == "report.pdf"
    assert second.name == "report-1.pdf"
    assert first.read_bytes() == b"first"


def test_the_name_is_claimed_atomically_not_checked_then_taken(workspace):
    """`effector_swarm` runs jobs concurrently against ONE workspace, so they share
    this directory. A check-then-write would let two callers both see `report.pdf`
    free and both take it — the loser's document silently overwritten, which is the
    exact failure this module exists to prevent.

    Reserving 200 times without writing anything in between is the test: if the name
    were only checked for existence, every call would return `report.pdf`.
    """
    d = workspace / DOWNLOADS_DIRNAME
    d.mkdir()
    reserved = [_reserve_path(d, "report.pdf") for _ in range(200)]
    assert len(set(reserved)) == 200


# ── the manager: saving ──────────────────────────────────────────────────────


def test_a_download_lands_in_the_workspace_with_a_relative_path(workspace):
    manager = DownloadManager(workspace=workspace)
    record = asyncio.run(manager.save(FakeDownload("statement.pdf", b"x" * 10)))

    assert record.ok
    assert record.path == "downloads/statement.pdf"
    assert record.bytes == 10
    # The path in the record is exactly what read_file takes: relative to the
    # workspace root. An absolute path here would be a path the agent cannot use.
    assert not os.path.isabs(record.path)
    assert (workspace / record.path).read_bytes() == b"x" * 10


def test_a_hostile_suggested_filename_still_lands_inside_the_downloads_directory(workspace):
    """The end-to-end version of the sanitisation tests: nothing outside the directory
    is ever written, whatever the page called the file."""
    manager = DownloadManager(workspace=workspace)
    record = asyncio.run(manager.save(FakeDownload("../../escape.pdf", b"nope")))

    assert record.ok
    written = Path(record.absolute_path).resolve()
    assert str(written).startswith(str((workspace / DOWNLOADS_DIRNAME).resolve()) + os.sep)
    assert not (workspace.parent / "escape.pdf").exists()


def test_a_browser_side_failure_is_reported_with_its_reason(workspace):
    manager = DownloadManager(workspace=workspace)
    record = asyncio.run(manager.save(FakeDownload("x.pdf", failure="net::ERR_FAILED")))

    assert not record.ok
    assert "net::ERR_FAILED" in record.error
    assert manager.saved() == []


def test_a_file_over_the_cap_is_refused_AND_removed(workspace):
    """The cap protects the container's disk, so a file left on disk after the cap
    fired protects nothing."""
    manager = DownloadManager(workspace=workspace, max_bytes=5)
    record = asyncio.run(manager.save(FakeDownload("big.bin", b"x" * 100)))

    assert not record.ok
    assert "cap" in record.error
    assert list((workspace / DOWNLOADS_DIRNAME).glob("big*")) == []


def test_the_file_count_cap_stops_at_the_limit(workspace):
    manager = DownloadManager(workspace=workspace, max_files=2)
    records = [asyncio.run(manager.save(FakeDownload(f"f{i}.txt"))) for i in range(4)]

    assert [r.ok for r in records] == [True, True, False, False]
    assert "limit" in records[2].error
    assert len(manager.saved()) == 2


def test_a_refusal_is_recorded_rather_than_dropped(workspace):
    """An agent told only about successes reads a refused download as a file nobody
    asked for, and tries the same thing again."""
    manager = DownloadManager(workspace=workspace, max_bytes=1)
    asyncio.run(manager.save(FakeDownload("big.bin", b"toolong")))

    assert len(manager.records()) == 1
    assert manager.records()[0].error
    assert manager.to_dicts()[0]["error"]


# ── the manager: passive capture ─────────────────────────────────────────────


def test_the_listener_only_enqueues_and_drain_does_the_work(workspace):
    """The handler registered on the context is synchronous on purpose: a coroutine
    handler that the emitter never awaits is indistinguishable from a site that never
    downloaded anything. Nothing may be written before drain() is awaited."""
    manager = DownloadManager(workspace=workspace)
    context = FakeContext()
    assert manager.attach(context) is True

    context.emit("download", FakeDownload("export.csv", b"a,b,c"))
    assert manager.pending == 1
    assert manager.records() == []            # nothing written yet
    assert not (workspace / DOWNLOADS_DIRNAME / "export.csv").exists()

    saved = asyncio.run(manager.drain())
    assert [r.filename for r in saved] == ["export.csv"]
    assert (workspace / DOWNLOADS_DIRNAME / "export.csv").read_bytes() == b"a,b,c"


def test_a_claimed_download_is_not_saved_a_second_time_by_drain(workspace):
    """`expect_download()` and the context listener see the SAME object for a download
    the agent explicitly asked for. Saving it twice invents a `report-1.pdf` that no
    site ever served."""
    manager = DownloadManager(workspace=workspace)
    context = FakeContext()
    manager.attach(context)

    download = FakeDownload("report.pdf")
    context.emit("download", download)        # the passive listener sees it
    manager.claim(download)                   # the download action takes ownership
    asyncio.run(manager.save(download))

    assert asyncio.run(manager.drain()) == []
    assert len(list((workspace / DOWNLOADS_DIRNAME).glob("report*"))) == 1


def test_attach_declines_rather_than_raising_on_an_object_with_no_on(workspace):
    """The native-engine branch of browser_session can hand back a browser rather than
    a context. Passive capture is a safety net; it must never take the session down."""
    manager = DownloadManager(workspace=workspace)
    assert manager.attach(object()) is False
    assert manager.attach(None) is False


def test_drain_is_safe_when_nothing_is_pending(workspace):
    manager = DownloadManager(workspace=workspace)
    assert asyncio.run(manager.drain()) == []


# ── fetch_url: the PDF-viewer path, and its egress guard ─────────────────────


def test_fetch_url_writes_the_bytes_and_names_the_file_from_the_url(workspace):
    manager = DownloadManager(workspace=workspace)
    page = FakePageWithRequest(FakeResponse(body=b"%PDF-1.7"))
    record = asyncio.run(manager.fetch_url(page, "https://example.test/files/statement.pdf"))

    assert record.ok
    assert record.filename == "statement.pdf"
    assert record.source == "fetch"
    assert (workspace / record.path).read_bytes() == b"%PDF-1.7"


def test_content_disposition_beats_the_url_path(workspace):
    """A URL path is often an opaque id; the server's own name for the file is better."""
    manager = DownloadManager(workspace=workspace)
    page = FakePageWithRequest(
        FakeResponse(headers={"content-disposition": 'attachment; filename="August Statement.pdf"'})
    )
    record = asyncio.run(manager.fetch_url(page, "https://example.test/dl?id=99182"))

    assert record.ok
    assert record.filename == "August Statement.pdf"


def test_rfc5987_filenames_are_decoded(workspace):
    """A non-ASCII invoice name arrives in `filename*`; reading only `filename=` gets
    the mangled ASCII fallback the server was forced to invent."""
    assert _filename_from_disposition(
        "attachment; filename*=UTF-8''Rechnung%20M%C3%A4rz.pdf"
    ) == "Rechnung März.pdf"


def test_a_disposition_filename_is_sanitised_like_any_other(workspace):
    """This one arrives in a header the attacker also controls."""
    manager = DownloadManager(workspace=workspace)
    page = FakePageWithRequest(
        FakeResponse(headers={"content-disposition": 'attachment; filename="../../owned.sh"'})
    )
    record = asyncio.run(manager.fetch_url(page, "https://example.test/dl"))

    assert record.ok
    assert "/" not in record.filename
    assert str(Path(record.absolute_path).resolve()).startswith(
        str((workspace / DOWNLOADS_DIRNAME).resolve()) + os.sep
    )


@pytest.mark.parametrize(
    "blocked",
    [
        "http://169.254.169.254/latest/meta-data/iam/security-credentials/",
        "http://localhost:8080/admin",
        "http://127.0.0.1/",
        "http://10.0.0.5/internal",
        "file:///etc/shadow",
    ],
)
def test_fetch_url_refuses_private_metadata_and_local_schemes(workspace, blocked):
    """**This check cannot be delegated to the network shield.** The shield enforces
    L7NetworkPolicy through `page.route`, and `page.route` intercepts requests the
    *page* makes. `page.request` is an APIRequestContext and does not pass through it,
    so without this check a model-supplied URL walks straight past the module written
    to stop exactly this.

    Fail-closed with no policy configured: a session without a session_domain has no
    L7NetworkPolicy at all (browser_session.py), and "nothing configured" must not
    read as "anything goes" on a path that writes bytes to disk.
    """
    manager = DownloadManager(workspace=workspace)          # note: no policy
    page = FakePageWithRequest(FakeResponse(body=b"secrets"))
    record = asyncio.run(manager.fetch_url(page, blocked))

    assert not record.ok
    assert "refused" in record.error
    assert page.request.requested == []                      # never even sent
    assert _files_in(workspace) == []


def test_a_redirect_into_a_private_host_is_caught_before_anything_is_written(workspace):
    """Redirects are followed inside Playwright, so the URL checked up front is not
    necessarily the one that answered."""
    manager = DownloadManager(workspace=workspace)
    response = FakeResponse(body=b"secrets", url="http://169.254.169.254/latest/meta-data/")
    page = FakePageWithRequest(response)
    record = asyncio.run(manager.fetch_url(page, "https://example.test/innocent.pdf"))

    assert not record.ok
    assert "redirect" in record.error
    assert _files_in(workspace) == []


def test_a_configured_network_policy_is_honoured(workspace):
    class DenyAll:
        def evaluate_url(self, url):
            return False, "not in task allowlist"

    manager = DownloadManager(workspace=workspace, policy=DenyAll())
    page = FakePageWithRequest(FakeResponse())
    record = asyncio.run(manager.fetch_url(page, "https://elsewhere.test/x.pdf"))

    assert not record.ok
    assert "allowlist" in record.error


def test_an_oversized_declared_length_is_refused_without_reading_the_body(workspace):
    """content-length is checked first so an honest-but-huge response is never read
    into memory at all."""
    manager = DownloadManager(workspace=workspace, max_bytes=100)
    page = FakePageWithRequest(FakeResponse(headers={"content-length": "999999999"}))
    record = asyncio.run(manager.fetch_url(page, "https://example.test/huge.zip"))

    assert not record.ok
    assert "declared" in record.error


def test_a_lying_content_length_is_still_caught_after_the_read(workspace):
    """A server that omits or lies about the length must not get past the cap."""
    manager = DownloadManager(workspace=workspace, max_bytes=5)
    page = FakePageWithRequest(FakeResponse(body=b"x" * 500))
    record = asyncio.run(manager.fetch_url(page, "https://example.test/huge.zip"))

    assert not record.ok
    assert "exceeds" in record.error


def test_an_http_error_is_reported_as_one(workspace):
    manager = DownloadManager(workspace=workspace)
    page = FakePageWithRequest(FakeResponse(status=403))
    record = asyncio.run(manager.fetch_url(page, "https://example.test/private.pdf"))

    assert not record.ok
    assert "403" in record.error


def test_a_page_with_no_request_context_says_so_instead_of_crashing(workspace):
    """The remote lane. RemotePage has no `request`, and the message has to name the
    reason rather than surfacing an AttributeError."""
    class NoRequestPage:
        url = "https://example.test/"

    manager = DownloadManager(workspace=workspace)
    record = asyncio.run(manager.fetch_url(NoRequestPage(), "https://example.test/a.pdf"))

    assert not record.ok
    assert "remote lane" in record.error


# ── small helpers ────────────────────────────────────────────────────────────


def test_an_extension_is_inferred_from_content_type_when_the_url_has_none():
    assert _filename_from_url("https://x.test/download?id=1", "application/pdf").endswith(".pdf")
    # A wrong guess is worse than no guess: an unknown type gets .bin, not a lie.
    assert _filename_from_url("https://x.test/download", "application/x-weird").endswith(".bin")


def test_pdf_viewer_detection_is_a_url_heuristic_and_nothing_more():
    assert looks_like_pdf_viewer("https://x.test/statement.pdf") is True
    assert looks_like_pdf_viewer("https://x.test/statement.pdf?token=abc") is True
    assert looks_like_pdf_viewer("https://x.test/page") is False
    assert looks_like_pdf_viewer(None) is False


# ── result visibility ────────────────────────────────────────────────────────


def test_a_successful_download_shows_its_path_back_to_the_model():
    """Measured 2026-09-01 on the first real agent run against an invoice portal: the
    model issued FIVE download actions for two files, re-downloading two of them,
    because a successful download rendered as a bare "download -> success" with no path
    and so looked like a no-op.

    That is the fourth instance of this loop's oldest lesson — the extract fix
    (2026-08-24), the select_combobox fix (2026-08-27) and the browser_exec branch each
    closed it for their own action. The duplicates were harmless (_reserve_path refuses
    to overwrite, so they landed as -1 files) but cost turns.
    """
    from nanoagent.agent.effector.react_loop import _recent_actions_text
    from nanoagent.agent.effector.types import EffectorTurnLog, Step, StepResult

    turn = EffectorTurnLog(
        turn=1,
        thought="save it",
        action=Step(step=1, action="download", target="@e5"),
        result=StepResult(
            step=1, status="success",
            data={"downloaded": {"path": "downloads/INV-302CA1.pdf", "bytes": 608}},
        ),
    )
    text = _recent_actions_text([turn])
    assert "downloads/INV-302CA1.pdf" in text
    assert "608" in text
    assert "do NOT download this again" in text
