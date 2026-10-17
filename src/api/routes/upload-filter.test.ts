/**
 * Upload filtering — what it does, and what it was already doing.
 *
 * Worth stating up front because I got this wrong once: the upload routes were NEVER
 * unfiltered. `refTypeForFilename` is an extension allowlist and all four handlers
 * (three in agents.ts, one in projects.ts) already refused anything it did not
 * recognise. `.svg` is not on that list, so an SVG could not be uploaded into a
 * workspace by this route at any point.
 *
 * The `fileFilter` added on 2026-09-02 is therefore a MEMORY fix, not a security one:
 * with `memoryStorage` and no filter, every byte of an unsupported file was buffered
 * into RAM and only then rejected — up to 300 x 10MB on the agent route, 25MB per file
 * on the project one.
 *
 * These tests pin the allowlist itself, because it is the actual security boundary and
 * it is a list someone will eventually be tempted to extend.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { refTypeForFilename } from './agents.js';

describe('the extension allowlist (the real boundary)', () => {
  it('accepts the text, code and data types an agent can actually read', () => {
    for (const name of [
      'notes.md',
      'data.csv',
      'config.yaml',
      'main.py',
      'app.tsx',
      'report.pdf',
    ]) {
      expect(refTypeForFilename(name)).toBeTruthy();
    }
  });

  it('accepts the extension-less files a source tree really contains', () => {
    for (const name of ['Dockerfile', 'Makefile', 'LICENSE', 'README']) {
      expect(refTypeForFilename(name)).toBeTruthy();
    }
  });

  it('rejects SVG — the type the file-serving audit was about', () => {
    // An SVG can carry <script>. It is served sandboxed now (file-serving.ts), but
    // it also cannot arrive through an upload, and both should stay true.
    expect(refTypeForFilename('logo.svg')).toBeNull();
    expect(refTypeForFilename('LOGO.SVG')).toBeNull();
  });

  it('rejects binaries and archives', () => {
    for (const name of [
      'photo.png',
      'archive.zip',
      'installer.exe',
      'lib.so',
      'movie.mp4',
    ]) {
      expect(refTypeForFilename(name)).toBeNull();
    }
  });

  it('judges by the LAST extension, not the first', () => {
    // `payload.txt.svg` is an SVG. A check that stopped at the first dot would let
    // it through.
    expect(refTypeForFilename('payload.txt.svg')).toBeNull();
    expect(refTypeForFilename('archive.tar.gz')).toBeNull();
  });

  it('is not fooled by a path or by case', () => {
    expect(refTypeForFilename('some/dir/NOTES.MD')).toBeTruthy();
    expect(refTypeForFilename('../../etc/passwd')).toBeNull();
  });
});

describe('the fileFilter', () => {
  const agents = readFileSync(join(__dirname, 'agents.ts'), 'utf-8');
  const projects = readFileSync(join(__dirname, 'projects.ts'), 'utf-8');

  it('is wired into both multer instances', () => {
    expect(agents).toMatch(
      /limits: \{ fileSize: 10 \* 1024 \* 1024, files: 300 \},\s*\n\s*fileFilter:/,
    );
    expect(projects).toMatch(
      /fileSize: 25 \* 1024 \* 1024 \},\s*\n\s*fileFilter:/,
    );
  });

  it('drops rather than errors, so one bad file does not fail a folder upload', () => {
    // cb(new Error(...)) would fail the whole request. Uploading a source tree with
    // one PNG in it currently succeeds for every other file, and a memory fix must
    // not cost that.
    for (const src of [agents, projects]) {
      const filter = src.slice(
        src.indexOf('fileFilter:'),
        src.indexOf('fileFilter:') + 600,
      );
      expect(filter).toContain('cb(null, false)');
      expect(filter).not.toContain('cb(new Error');
    }
  });

  it('still reports what it dropped, in every handler', () => {
    // The filter runs before the handler, so a dropped file is invisible to it —
    // without this the caller would get a silent success and a missing file.
    const seeded =
      agents.match(
        /const skipped: string\[\] = \[\.\.\.rejectedUploads\(req\)\]/g,
      ) ?? [];
    expect(seeded.length).toBe(3);
    expect(projects).toContain('[...rejectedUploads(req)]');
  });

  it('does not replace the handler-side check', () => {
    // multer only sees `originalname`; two handlers prefer a client-supplied
    // relative path. The per-file check in the loop is the authoritative gate and
    // must survive.
    const checks =
      agents.match(/const type = refTypeForFilename\(rawName\)/g) ?? [];
    expect(checks.length).toBeGreaterThanOrEqual(2);
    expect(projects).toContain('refTypeForFilename(rawName)');
  });
});
