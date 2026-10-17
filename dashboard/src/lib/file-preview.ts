/**
 * Which files must never be read as text, and where a download actually goes.
 *
 * Found 2026-09-22: opening an .xlsx from the Workspace panel fetched it with
 * `r.text()` and rendered the result in a `<pre>` — no different from opening a .py
 * file. An .xlsx is a ZIP container, so what showed up was the raw PK-signature byte
 * soup of the archive, decoded as if it were UTF-8. Nothing in the UniversalDrawer
 * fetch or render path checked whether a file WAS text before treating it as text; the
 * only special case that existed was images.
 *
 * This is the positive fix for that gap: a known-extension check, same shape as the
 * `isImageFile` it sits beside, so a binary file short-circuits BEFORE the fetch (no
 * point downloading megabytes just to throw them away) and renders a "no preview"
 * state instead of garbage.
 */

/** Formats this app knows it cannot render as text, ever. Not exhaustive — the goal is
 * to catch the common real cases (office documents, archives, media, executables), not
 * to enumerate every binary format that exists. An unknown extension still falls through
 * to being treated as text, exactly as it always has; this only ever REMOVES files from
 * that path, never adds risk to one that worked before.
 *
 * xlsx/xlsm/docx are in here too, deliberately — they are still binary (a spreadsheet or
 * Word document is a ZIP container) and must never be text-fetched. They ALSO have a
 * real renderer now (XlsxViewer, DocxViewer), which the caller checks for first via
 * isSpreadsheetFile/isDocxFile below. This set stays the single source of truth for "not
 * text", and the two extra predicates layer "and also, THIS specific binary format has
 * somewhere better to go than the download-only fallback." */
const BINARY_EXTENSIONS = new Set([
    // office documents — zip containers, not text
    'xlsx', 'xls', 'xlsm', 'docx', 'doc', 'pptx', 'ppt', 'odt', 'ods', 'odp',
    // archives
    'zip', 'tar', 'gz', 'tgz', 'bz2', '7z', 'rar', 'xz',
    // documents with their own renderer elsewhere, or none here
    'pdf',
    // media — already excluded from the text path by ext-specific checks upstream in
    // some callers, but not all; safe to name here too
    'mp3', 'wav', 'ogg', 'flac', 'mp4', 'webm', 'mov', 'avi', 'mkv',
    // fonts, binaries, databases
    'woff', 'woff2', 'ttf', 'otf', 'eot',
    'exe', 'dll', 'so', 'dylib', 'bin', 'dat', 'wasm',
    'db', 'sqlite', 'sqlite3',
]);

/** True for a file this app must not fetch-and-decode as text. */
export function isBinaryFile(filename: string): boolean {
    const ext = filename.split('.').pop()?.toLowerCase() ?? '';
    return BINARY_EXTENSIONS.has(ext);
}

/** A real spreadsheet — has XlsxViewer, not the "no preview" fallback. `.xls` (the old
 * binary format, not a ZIP container) is deliberately excluded: SheetJS reads it too,
 * but this app has no live one to have tested that path against yet — safer to leave
 * it on the honest "no preview" state than claim support unverified. */
export function isSpreadsheetFile(filename: string): boolean {
    const ext = filename.split('.').pop()?.toLowerCase() ?? '';
    return ext === 'xlsx' || ext === 'xlsm';
}

/** A real Word document — has DocxViewer, not the "no preview" fallback. Same reasoning
 * as isSpreadsheetFile on scope: `.doc` (the old binary format) is not mammoth's format
 * and stays on the download-only path. */
export function isDocxFile(filename: string): boolean {
    const ext = filename.split('.').pop()?.toLowerCase() ?? '';
    return ext === 'docx';
}

/**
 * A same-origin relative URL, made absolute against `origin`.
 *
 * Needed because Electron's `shell.openExternal` (what the desktop app's
 * `setWindowOpenHandler` calls for every `window.open`, and the path a download can end
 * up on) hands the string straight to the OS. A relative path like
 * `/api/files/content?...` means nothing outside the page it came from; the OS has no
 * origin to resolve it against and the request goes nowhere; observed as a download
 * button that neither opens anything nor produces a file. An absolute URL is the one
 * shape that works identically inside the app, in a new browser tab, or handed to the
 * OS.
 *
 * `origin` is a parameter rather than read from `window.location` here so this stays a
 * pure function — the caller (running in the browser) passes its own origin.
 */
export function toAbsoluteUrl(path: string, origin: string): string {
    if (/^https?:\/\//i.test(path)) return path; // already absolute
    const base = origin.replace(/\/+$/, '');
    const rel = path.startsWith('/') ? path : `/${path}`;
    return base + rel;
}
