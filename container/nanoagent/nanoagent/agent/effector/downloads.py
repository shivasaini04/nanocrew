"""Getting a file OFF a page and into the agent's workspace — stage45 gap E.

Before this module, `grep -rn download effector/**/*.py` returned nothing. There was
an `upload` action and no way back: every "download the statement", "export the CSV",
"save the invoice" job was out of reach, and `blueprints/invoice_receipt_extractor.py`
had already shipped without the one capability its name promises.

Three ways a file leaves a page, and this module covers all three:

  1. **A download the agent asked for** — the `download` action with a target. The
     click happens inside `page.expect_download()`, so the wait is deterministic.
  2. **A download nothing asked for** — a plain `click` that turns out to be an export
     button. Playwright buffers these to a temp file and *deletes them when the context
     closes* unless something calls `save_as`. Without passive capture the file is
     silently gone and the step still reports success — the exact "it looked like it
     worked" shape CLAUDE.md catalogues. Hence `attach()`.
  3. **A file the browser renders instead of saving** — the PDF case. Chromium's
     internal viewer and Firefox's pdf.js both display a PDF rather than downloading
     it, so no download event ever fires and there is nothing to capture. The only way
     out is to re-request the bytes ourselves, through the page's own cookies:
     `fetch_url()`. browser-use reaches the same conclusion by a longer road
     (`downloads_watchdog.py`'s `check_for_pdf_viewer` / `trigger_pdf_download`).

## Why the event handler does nothing but enqueue

`context.on("download", ...)` is registered with a **synchronous** callback that appends
to a queue. The saving happens later, in `drain()`, which the executor awaits at each
step boundary.

That split is deliberate. Whether Playwright's async event emitter awaits a coroutine
handler is a real question with a version-dependent answer, and a handler that is
silently never awaited is indistinguishable from a site that never downloaded anything.
A sync handler cannot fail that way. It also puts the file I/O on the loop's own turn
boundary, where a failure can be reported into the step result, instead of inside a
callback whose exceptions go to a log nobody reads.

## What is deliberately not here

- **No streaming size cap on the event path.** Playwright hands us a completed temp
  file; by the time we see it, it is already on disk. The cap is enforced after the
  fact (the file is deleted and the record carries the error) rather than by aborting
  mid-transfer. `fetch_url` *can* check `content-length` up front and does.
- **No resume, no partial files, no progress.** A download either lands or is recorded
  as failed.
- **Nothing for the remote lane.** The extension has no download API; see
  `remote_page.py`, which refuses rather than pretending.
"""

from __future__ import annotations

import os
import re
import unicodedata
from collections import deque
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any, Literal
from urllib.parse import unquote, urlparse

from loguru import logger

# A per-cycle container has a modest disk and no cleanup story of its own. 100 MB is
# well above an invoice, a CSV export or a bank statement, and well below anything that
# fills the volume. Callers that genuinely need more pass max_bytes.
_DEFAULT_MAX_BYTES = 100 * 1024 * 1024

# Bounds the blast radius of a page that triggers a download on every click.
_DEFAULT_MAX_FILES = 50

# ext4 allows 255 BYTES, not characters — a name of 200 CJK characters is over the limit
# while 200 ASCII ones are not, so the truncation below counts bytes. The margin left
# over is for the "-1", "-2" collision suffixes.
_MAX_NAME_BYTES = 200

_CONTROL_CHARS = re.compile(r"[\x00-\x1f\x7f]")
_PATH_SEPARATORS = re.compile(r"[\\/]+")

# The container is Linux, so these are not reserved *here*. They are handled anyway
# because a workspace is a directory a human syncs, zips and opens on their own laptop,
# and a file called `CON.pdf` is an unpleasant surprise to hand someone.
_WINDOWS_RESERVED = {
    "con", "prn", "aux", "nul",
    *(f"com{i}" for i in range(1, 10)),
    *(f"lpt{i}" for i in range(1, 10)),
}

# Only used when a URL gives no filename at all. Deliberately short: guessing an
# extension wrong is worse than `.bin`, which at least does not lie about the content.
_CONTENT_TYPE_EXTENSIONS = {
    "application/pdf": ".pdf",
    "text/csv": ".csv",
    "application/json": ".json",
    "text/plain": ".txt",
    "text/html": ".html",
    "application/zip": ".zip",
    "image/png": ".png",
    "image/jpeg": ".jpg",
    "application/vnd.ms-excel": ".xls",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": ".xlsx",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document": ".docx",
    "application/msword": ".doc",
}

# The subdirectory downloads land in, relative to the agent's workspace. Chosen so the
# path in a DownloadRecord is exactly what the agent passes to `read_file` — the
# filesystem tools resolve relative paths against the workspace root
# (tools/filesystem.py:_resolve_path), so "downloads/statement.pdf" just works.
DOWNLOADS_DIRNAME = "downloads"


@dataclass
class DownloadRecord:
    """One file that reached the workspace, or one that tried and did not."""

    filename: str
    # Workspace-relative — this is the field the model is shown and the string it
    # hands to read_file. The absolute path is kept for callers that need it but is
    # not what the agent should be reasoning with.
    path: str
    absolute_path: str
    bytes: int
    source: Literal["event", "fetch"]
    url: str | None = None
    suggested_filename: str | None = None
    error: str | None = None

    @property
    def ok(self) -> bool:
        return self.error is None

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


def safe_filename(suggested: str | None, *, fallback: str = "download.bin") -> str:
    """Reduce an attacker-controlled filename to a plain basename that cannot escape
    the downloads directory.

    `suggested_filename` comes from the page — the `download` attribute or a
    Content-Disposition header — so it is untrusted input that gets used as a path.
    Everything here is a real attack or a real annoyance, not a hypothetical:
    `../../.ssh/authorized_keys`, `/etc/passwd`, a NUL byte truncating the name in a
    C library underneath, a name so long the write fails with ENAMETOOLONG.
    """
    name = (suggested or "").strip()

    # Percent-encoding hides separators from a naive check: `..%2Fescape` is `../escape`
    # once anything decodes it. Decode first, then look for separators.
    if "%" in name:
        try:
            name = unquote(name)
        except Exception:
            pass

    # NFC-normalise before the separator split: a decomposed form can carry combining
    # characters that render as something other than what the check saw.
    try:
        name = unicodedata.normalize("NFC", name)
    except Exception:
        pass

    name = _CONTROL_CHARS.sub("", name)

    # Take the LAST non-empty path component under either separator. This is what makes
    # traversal impossible rather than merely awkward — after this line there is no
    # separator left in the string, so `..` cannot mean a parent of anything.
    parts = [p for p in _PATH_SEPARATORS.split(name) if p]
    name = parts[-1] if parts else ""

    # Windows chokes on these in a filename and a workspace gets opened on Windows.
    name = re.sub(r'[<>:"|?*]', "_", name)

    # Trailing dots and spaces are stripped by the Windows filesystem itself, which
    # turns "report.pdf " into a different name than the one recorded here.
    name = name.rstrip(". ")
    # A leading dot makes the file invisible to `list_dir`, so the agent downloads
    # something and then cannot see it. Strip rather than reject.
    name = name.lstrip(".")

    if not name or name in {".", ".."}:
        return fallback

    stem, ext = os.path.splitext(name)
    if stem.lower() in _WINDOWS_RESERVED:
        stem = f"_{stem}"
        name = stem + ext

    # Truncate in BYTES, keeping the extension: the extension is what tells the agent
    # (and the human) what the file is, so losing it to a long stem is the wrong trade.
    if len(name.encode("utf-8", "ignore")) > _MAX_NAME_BYTES:
        ext_bytes = len(ext.encode("utf-8", "ignore"))
        budget = max(1, _MAX_NAME_BYTES - ext_bytes)
        truncated = stem.encode("utf-8", "ignore")[:budget]
        # A byte-slice can land mid-character; "ignore" drops the partial one.
        stem = truncated.decode("utf-8", "ignore") or "download"
        name = stem + ext

    return name or fallback


def _reserve_path(directory: Path, filename: str) -> Path:
    """`report.pdf` twice gives `report.pdf` and `report-1.pdf` — never an overwrite.

    Two downloads of the same statement are usually a retry, but they are sometimes two
    genuinely different months that the site names identically. Overwriting silently
    picks one interpretation and destroys the evidence for the other.

    **The name is claimed by creating the file, not by checking whether it exists.**
    `effector_swarm` runs several jobs concurrently against ONE workspace, so they
    share this directory. A check-then-write would let two jobs both see `report.pdf`
    free and both take it, and the loser's file would be silently overwritten by the
    winner — a lost document that nothing reports, which is the whole failure mode this
    module exists to prevent. O_CREAT|O_EXCL makes the claim and the check the same
    operation. The empty placeholder it leaves is overwritten by the real write a
    moment later.
    """
    stem, ext = os.path.splitext(filename)
    for i in range(0, 1000):
        candidate = directory / (filename if i == 0 else f"{stem}-{i}{ext}")
        try:
            fd = os.open(candidate, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
        except FileExistsError:
            continue
        except OSError:
            # A name the filesystem rejects for a reason sanitisation did not cover.
            # Fall through to the random suffix rather than failing the download.
            break
        os.close(fd)
        return candidate

    # A thousand collisions means something is looping; a random suffix ends it rather
    # than raising, because losing the file is worse than an ugly name.
    candidate = directory / f"{stem}-{os.urandom(4).hex()}{ext}"
    candidate.touch(exist_ok=True)
    return candidate


def _is_contained(directory: Path, filename: str) -> bool:
    """Whether `directory / filename` really lands inside `directory`.

    Separate from safe_filename so the guarantee is checked rather than assumed: this
    is what still holds if the sanitiser has a bug, and it costs two syscalls.
    """
    try:
        root = directory.resolve()
        return str((directory / filename).resolve()).startswith(str(root) + os.sep)
    except Exception:
        return False


def _filename_from_url(url: str, content_type: str | None = None) -> str:
    """Best-effort name for a direct fetch, which has no `suggested_filename`."""
    try:
        path = urlparse(url).path
    except Exception:
        path = ""
    base = path.rsplit("/", 1)[-1] if path else ""
    name = safe_filename(base, fallback="")

    if name and os.path.splitext(name)[1]:
        return name

    # No extension: take one from the Content-Type rather than leaving the agent
    # guessing what it just saved.
    ext = ""
    if content_type:
        ext = _CONTENT_TYPE_EXTENSIONS.get(content_type.split(";")[0].strip().lower(), "")
    return (name or "download") + (ext or ".bin")


def _filename_from_disposition(header: str | None) -> str | None:
    """Pull a filename out of a Content-Disposition header.

    Handles RFC 5987's `filename*=UTF-8''...` form as well as plain `filename=`,
    because a non-ASCII invoice name arrives in the former and reading only the latter
    gets you the ASCII fallback the server was forced to invent.
    """
    if not header:
        return None

    star = re.search(r"filename\*\s*=\s*([^;]+)", header, re.IGNORECASE)
    if star:
        value = star.group(1).strip().strip('"')
        # charset'language'percent-encoded-name
        parts = value.split("'", 2)
        encoded = parts[2] if len(parts) == 3 else value
        try:
            return unquote(encoded)
        except Exception:
            return encoded

    plain = re.search(r'filename\s*=\s*"([^"]*)"', header, re.IGNORECASE)
    if plain:
        return plain.group(1)
    plain = re.search(r"filename\s*=\s*([^;]+)", header, re.IGNORECASE)
    if plain:
        return plain.group(1).strip()
    return None


def looks_like_pdf_viewer(url: str | None) -> bool:
    """Whether the browser is probably *displaying* a PDF rather than having saved it.

    Deliberately a URL heuristic and nothing more. The reliable test is the response's
    Content-Type, which is not available from a page object after the fact without
    re-requesting — and re-requesting is exactly what `fetch_url` does anyway. So this
    only decides whether `download` with no target is a sensible thing to try; it never
    decides what the file IS.
    """
    if not url:
        return False
    try:
        path = urlparse(url).path.lower()
    except Exception:
        return False
    return path.endswith(".pdf")


@dataclass
class DownloadManager:
    """Owns one downloads directory and the queue of downloads waiting to be saved.

    One per EffectorSession. `attach()` binds it to a Playwright context (or page);
    `drain()` is what actually writes files and is safe to call at any time, including
    when nothing is pending.
    """

    workspace: Path
    max_bytes: int = _DEFAULT_MAX_BYTES
    max_files: int = _DEFAULT_MAX_FILES
    # The run's L7NetworkPolicy, when the session has one (it needs a session_domain).
    # Only `fetch_url` consults it — see _check_egress for why that path needs its own
    # check at all when the rest of the browser is already behind the network shield.
    policy: Any = None

    _pending: deque = field(default_factory=deque, repr=False)
    _records: list[DownloadRecord] = field(default_factory=list, repr=False)
    # Identity of every Download object already handled. `expect_download()` and the
    # registered listener both see the same object for a download the agent explicitly
    # asked for, and saving it twice would produce a phantom `report-1.pdf`.
    _seen: set[int] = field(default_factory=set, repr=False)
    _attached: bool = field(default=False, repr=False)

    def __post_init__(self) -> None:
        self.workspace = Path(self.workspace)

    @property
    def directory(self) -> Path:
        d = self.workspace / DOWNLOADS_DIRNAME
        d.mkdir(parents=True, exist_ok=True)
        return d

    # ── capture ──────────────────────────────────────────────────────────────

    def attach(self, target: Any) -> bool:
        """Listen for downloads on a Playwright context (preferred) or page.

        Returns whether the listener was actually registered. False is a real answer,
        not a failure: the native-engine path can hand back an object that is a browser
        rather than a context, and a caller that assumes `.on` exists crashes the whole
        session over a passive safety net. The explicit `download` action still works.
        """
        if target is None or self._attached:
            return False
        on = getattr(target, "on", None)
        if not callable(on):
            logger.debug("effector: download capture unavailable — no .on() on the context")
            return False
        try:
            on("download", self._enqueue)
        except Exception as err:  # pragma: no cover - defensive, engine-dependent
            logger.debug(f"effector: could not register the download listener — {err}")
            return False
        self._attached = True
        return True

    def _enqueue(self, download: Any) -> None:
        """Synchronous by design — see the module docstring. Does no I/O."""
        if id(download) in self._seen:
            return
        self._pending.append(download)

    def claim(self, download: Any) -> None:
        """Mark a Download as already handled so `drain()` skips it.

        Used by the executor's explicit `download` action, which saves the file itself
        through `expect_download()` and would otherwise see the same object come round
        again on the passive queue.
        """
        self._seen.add(id(download))

    @property
    def pending(self) -> int:
        return len(self._pending)

    # ── saving ───────────────────────────────────────────────────────────────

    async def drain(self) -> list[DownloadRecord]:
        """Save every queued download. Returns only the records created by THIS call,
        so a caller can report what one step produced rather than the whole run."""
        new: list[DownloadRecord] = []
        while self._pending:
            download = self._pending.popleft()
            if id(download) in self._seen:
                continue
            self._seen.add(id(download))
            new.append(await self.save(download))
        return new

    async def save(self, download: Any) -> DownloadRecord:
        """Write one Playwright Download into the workspace and record what happened."""
        suggested = None
        url = None
        try:
            suggested = download.suggested_filename
            url = download.url
        except Exception:
            pass

        record = DownloadRecord(
            filename="", path="", absolute_path="", bytes=0,
            source="event", url=url, suggested_filename=suggested,
        )

        if len(self.saved()) >= self.max_files:
            record.error = f"download limit reached ({self.max_files} files this run)"
            self._records.append(record)
            logger.warning(f"effector: {record.error}")
            return record

        try:
            # A download that failed browser-side has a reason; save_as would raise a
            # less informative error over the top of it.
            failure = await download.failure()
            if failure:
                record.error = f"the browser reported the download failed: {failure}"
                self._records.append(record)
                return record

            filename = safe_filename(suggested, fallback=_filename_from_url(url or ""))

            # Belt and braces over safe_filename: this is the check that still holds if
            # the sanitiser has a bug. Checked BEFORE the name is reserved, so a refusal
            # does not leave an empty placeholder behind.
            if not _is_contained(self.directory, filename):
                record.error = "refused: the download's filename resolved outside the downloads directory"
                record.filename = filename
                self._records.append(record)
                logger.warning(f"effector: {record.error} (suggested={suggested!r})")
                return record

            destination = _reserve_path(self.directory, filename)
            await download.save_as(str(destination))
            size = destination.stat().st_size

            if size > self.max_bytes:
                # Deleted rather than kept: the cap exists to protect the container's
                # disk, and a file left in place after the cap fired protects nothing.
                destination.unlink(missing_ok=True)
                record.error = (
                    f"refused: {size} bytes exceeds the {self.max_bytes}-byte download cap"
                )
                record.filename = filename
                self._records.append(record)
                logger.warning(f"effector: {record.error}")
                return record

            record.filename = destination.name
            record.path = f"{DOWNLOADS_DIRNAME}/{destination.name}"
            record.absolute_path = str(destination)
            record.bytes = size
            logger.info(f"effector: downloaded {record.path} ({size} bytes)")
        except Exception as err:
            record.error = f"could not save the download: {err}"
            logger.warning(f"effector: {record.error}")

        self._records.append(record)
        return record

    # ── egress ───────────────────────────────────────────────────────────────

    def _check_egress(self, url: str) -> str | None:
        """The reason `url` may not be fetched, or None if it may.

        **`fetch_url` needs its own check because the network shield cannot see it.**
        `stealth/network_shield.py` enforces `L7NetworkPolicy` through a `page.route`
        handler, and `page.route` intercepts requests the *page* makes. Playwright's
        APIRequestContext — which is what `page.request` is, and what makes the cookie
        sharing work — does not pass through page routes at all. So a URL that arrives
        here from a model would otherwise reach `169.254.169.254` by walking straight
        past the module written to stop exactly that.

        Fail-closed on private and metadata hosts even when no policy is configured:
        a session without a `session_domain` has no L7NetworkPolicy (see
        browser_session.py:588), and "no policy configured" must not read as "anything
        goes" on a path that writes bytes to disk.
        """
        try:
            from nanoagent.agent.effector.security.network_policy import is_private_or_metadata_host
        except Exception:  # pragma: no cover - the module is in-tree
            is_private_or_metadata_host = None

        parsed = None
        try:
            parsed = urlparse(url)
        except Exception:
            return "that URL could not be parsed"

        scheme = (parsed.scheme or "").lower()
        if scheme not in ("http", "https"):
            # No file:, no data:. A download writes to disk, and `file:///etc/shadow`
            # would be a copy rather than a fetch.
            return f"refused: downloads are limited to http and https, not {scheme or 'a relative URL'}"

        host = parsed.hostname or ""
        if not host:
            return "refused: that URL has no host"

        if is_private_or_metadata_host is not None and is_private_or_metadata_host(host):
            return f"refused: {host} is a private or cloud-metadata address"

        if self.policy is not None:
            try:
                allowed, reason = self.policy.evaluate_url(url)
                if not allowed:
                    return f"refused by the task's network policy: {reason}"
            except Exception as err:  # pragma: no cover - defensive
                logger.debug(f"effector: download policy check failed open-ended — {err}")

        return None

    # ── direct fetch (the PDF-viewer path) ───────────────────────────────────

    async def fetch_url(self, page: Any, url: str) -> DownloadRecord:
        """Re-request `url` through the page's own session and write the bytes out.

        This is how a PDF the browser is *displaying* becomes a file. No download event
        ever fires for it — the viewer is doing its job — so there is nothing to capture
        and the bytes have to be asked for again. Going through Playwright's request
        context rather than a bare httpx call is the whole point: it carries the
        context's cookies, so a statement behind a login is reachable.
        """
        record = DownloadRecord(
            filename="", path="", absolute_path="", bytes=0, source="fetch", url=url,
        )

        if len(self.saved()) >= self.max_files:
            record.error = f"download limit reached ({self.max_files} files this run)"
            self._records.append(record)
            return record

        refusal = self._check_egress(url)
        if refusal:
            record.error = refusal
            self._records.append(record)
            logger.warning(f"effector: {refusal} ({url})")
            return record

        request = getattr(page, "request", None)
        if request is None:
            context = getattr(page, "context", None)
            request = getattr(context, "request", None)
        if request is None:
            record.error = (
                "this page has no request context, so a direct fetch is not possible "
                "(the remote lane cannot download — see remote_page.py)"
            )
            self._records.append(record)
            return record

        try:
            response = await request.get(url)

            # Redirects are followed automatically, so the URL checked above is not
            # necessarily the one that answered: a public URL can 302 to an internal
            # one. Re-check where we actually landed BEFORE reading or writing a byte
            # of it.
            #
            # Honest about what this does and does not close: an internal host can
            # still be *reached* by a redirect (a blind SSRF), because the redirect is
            # followed inside Playwright before we get a say. What it closes is the
            # part that matters here — nothing that host returns is ever written to the
            # workspace or shown to the model.
            final_url = getattr(response, "url", None) or url
            if final_url != url:
                refusal = self._check_egress(final_url)
                if refusal:
                    record.error = f"{refusal} (after a redirect from the URL requested)"
                    record.url = final_url
                    self._records.append(record)
                    logger.warning(f"effector: {record.error}")
                    return record

            status = response.status
            if status >= 400:
                record.error = f"the server answered {status} for that URL"
                self._records.append(record)
                return record

            headers = {}
            try:
                headers = {k.lower(): v for k, v in (response.headers or {}).items()}
            except Exception:
                pass

            # Check the advertised length BEFORE reading the body into memory. A server
            # that lies or omits it is caught by the second check below; this one keeps
            # the honest-but-huge case from being read at all.
            declared = headers.get("content-length")
            if declared and str(declared).isdigit() and int(declared) > self.max_bytes:
                record.error = (
                    f"refused: the server declared {declared} bytes, over the "
                    f"{self.max_bytes}-byte download cap"
                )
                self._records.append(record)
                return record

            body = await response.body()
            if len(body) > self.max_bytes:
                record.error = (
                    f"refused: {len(body)} bytes exceeds the {self.max_bytes}-byte download cap"
                )
                self._records.append(record)
                return record

            # Content-Disposition is the server's own name for the file and beats a URL
            # path, which is often an opaque id. Sanitised like any other page-supplied
            # name — this one arrives in a header an attacker also controls.
            content_type = headers.get("content-type")
            filename = _filename_from_disposition(headers.get("content-disposition"))
            filename = safe_filename(
                filename or _filename_from_url(url, content_type),
                fallback=_filename_from_url(url, content_type),
            )

            if not _is_contained(self.directory, filename):
                record.error = "refused: the filename resolved outside the downloads directory"
                record.filename = filename
                self._records.append(record)
                return record

            destination = _reserve_path(self.directory, filename)
            destination.write_bytes(body)
            record.filename = destination.name
            record.path = f"{DOWNLOADS_DIRNAME}/{destination.name}"
            record.absolute_path = str(destination)
            record.bytes = len(body)
            logger.info(f"effector: fetched {record.path} ({record.bytes} bytes) from {url}")
        except Exception as err:
            record.error = f"could not fetch that URL: {err}"
            logger.warning(f"effector: {record.error}")

        self._records.append(record)
        return record

    # ── reporting ────────────────────────────────────────────────────────────

    def records(self) -> list[DownloadRecord]:
        return list(self._records)

    def saved(self) -> list[DownloadRecord]:
        return [r for r in self._records if r.ok]

    def to_dicts(self) -> list[dict[str, Any]]:
        return [r.to_dict() for r in self._records]
