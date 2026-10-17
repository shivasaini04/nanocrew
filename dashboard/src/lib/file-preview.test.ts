/**
 * Found 2026-09-22: an .xlsx opened from the Workspace panel was fetched with
 * `r.text()` and rendered straight into a `<pre>`. An .xlsx is a ZIP archive, so what
 * showed up on screen was the raw PK-signature bytes of the container, decoded as if
 * they were UTF-8 — the same "PK\u0002\u0004..." soup a broken text editor produces on
 * any binary file. Nothing checked file type before treating it as text; the only
 * special case that existed was images.
 */
import { describe, expect, it } from 'vitest';
import { isBinaryFile, isDocxFile, isSpreadsheetFile, toAbsoluteUrl } from './file-preview';

describe('isBinaryFile', () => {
    it('catches the file that started this — a real spreadsheet', () => {
        expect(isBinaryFile('session_songs_played.xlsx')).toBe(true);
    });

    it('catches office documents generally, not just this one format', () => {
        for (const name of ['report.docx', 'deck.pptx', 'budget.xls', 'notes.odt']) {
            expect(isBinaryFile(name)).toBe(true);
        }
    });

    it('catches archives, media and executables', () => {
        for (const name of ['bundle.zip', 'clip.mp4', 'song.mp3', 'app.exe', 'lib.dll']) {
            expect(isBinaryFile(name)).toBe(true);
        }
    });

    it('never flags an ordinary text or code file — this must only ever remove files '
        + 'from the text path, never add one that worked before', () => {
        for (const name of ['notes.md', 'data.json', 'script.py', 'index.ts', 'log.txt',
                            'styles.css', 'table.csv', 'README']) {
            expect(isBinaryFile(name)).toBe(false);
        }
    });

    it('is case-insensitive — a file picker or an upload can hand back either case', () => {
        expect(isBinaryFile('REPORT.XLSX')).toBe(true);
    });

    it('reads the extension after the LAST dot, not the first', () => {
        // A file like "q3.summary.xlsx" must be caught by "xlsx", not by "summary".
        expect(isBinaryFile('q3.summary.xlsx')).toBe(true);
        expect(isBinaryFile('my.notes.md')).toBe(false);
    });

    it('an unknown extension is not assumed binary', () => {
        // The point of a known-list check: false negatives (an untagged binary format
        // slipping through) degrade to today's existing behaviour, which is acceptable.
        // False positives (a real text format wrongly blocked) would not be.
        expect(isBinaryFile('config.weirdext')).toBe(false);
    });

    it('a filename with no extension at all does not crash', () => {
        expect(isBinaryFile('Makefile')).toBe(false);
        expect(isBinaryFile('')).toBe(false);
    });
});

describe('isSpreadsheetFile / isDocxFile', () => {
    it('a real xlsx has a real viewer, not the download-only fallback', () => {
        expect(isSpreadsheetFile('session_songs_played.xlsx')).toBe(true);
        expect(isSpreadsheetFile('budget.xlsm')).toBe(true);
    });

    it('a real docx has a real viewer', () => {
        expect(isDocxFile('resume.docx')).toBe(true);
    });

    it('the old binary formats (.xls, .doc) stay on the honest "no preview" path — '
        + 'this app has never tested SheetJS/mammoth against them', () => {
        expect(isSpreadsheetFile('legacy.xls')).toBe(false);
        expect(isDocxFile('legacy.doc')).toBe(false);
    });

    it('is not confused by the other format\'s extension', () => {
        expect(isSpreadsheetFile('resume.docx')).toBe(false);
        expect(isDocxFile('budget.xlsx')).toBe(false);
    });

    it('every file with a real viewer is still, correctly, a binary file — the two '
        + 'checks answer different questions and must never disagree on this', () => {
        expect(isBinaryFile('session_songs_played.xlsx')).toBe(true);
        expect(isBinaryFile('resume.docx')).toBe(true);
    });

    it('is case-insensitive, same as isBinaryFile', () => {
        expect(isSpreadsheetFile('REPORT.XLSX')).toBe(true);
        expect(isDocxFile('RESUME.DOCX')).toBe(true);
    });
});

describe('toAbsoluteUrl', () => {
    const origin = 'https://nanocrew.example.com';

    it('turns the exact relative shape this app uses into a real URL', () => {
        expect(toAbsoluteUrl('/api/files/content?context=agent&path=a.xlsx', origin))
            .toBe('https://nanocrew.example.com/api/files/content?context=agent&path=a.xlsx');
    });

    it('adds the missing leading slash rather than concatenating wrong', () => {
        expect(toAbsoluteUrl('api/files/content', origin))
            .toBe('https://nanocrew.example.com/api/files/content');
    });

    it('does not double up a trailing slash on the origin', () => {
        expect(toAbsoluteUrl('/api/x', 'https://nanocrew.example.com/'))
            .toBe('https://nanocrew.example.com/api/x');
    });

    it('leaves an already-absolute URL alone', () => {
        // A caller that already built a full URL must not get a mangled second origin
        // stitched onto the front of it.
        expect(toAbsoluteUrl('https://other.example/file.xlsx', origin))
            .toBe('https://other.example/file.xlsx');
    });
});
