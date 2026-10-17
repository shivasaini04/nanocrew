/**
 * Stage 58 — what an agent-written HTML page remembers.
 *
 * An agent writes a self-contained HTML file; when its owner opens it anywhere in the
 * dashboard (workspace drawer, Files page, Artifacts tab, chat card, full-page view), the
 * page can store state through `window.NanoCrewPage` — a checklist's ticks, a grading
 * form's grades. This is where that state lives, keyed by the FILE, so it survives a
 * reload and is the same wherever the page is opened.
 *
 * Trust boundary: the page runs in a sandboxed iframe with no `allow-same-origin`, so it
 * has no cookie and cannot call this API itself. The trusted parent (ArtifactFrame)
 * relays its postMessage requests here with the owner's session. A page can therefore
 * only ever reach its own file's documents.
 */
import { Router, type Request, type Response } from 'express';

import {
  getAgent,
  listArtifactDocs,
  getArtifactDoc,
  upsertArtifactDoc,
  deleteArtifactDoc,
} from '../../db.js';
import { ownsResource } from '../middleware/ownership.js';

export const artifactDocsRouter: Router = Router();

const MAX_DOC_BYTES = 256 * 1024;
const MAX_DOC_ID = 200;

/**
 * One key per file, whichever surface opened it. The same page reaches here as
 * `/workspace/group/workspace/x.html` (a write_file step), `workspace/x.html` (the
 * emit_artifact manifest) and `x.html` (the files API, already relative to workspace/).
 * If those were three keys, the page would remember different things in different tabs.
 */
export function normaliseArtifactPath(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  let p = raw.trim().replace(/\\/g, '/');
  if (p.startsWith('/workspace/group/'))
    p = p.slice('/workspace/group/'.length);
  p = p.replace(/^\/+/, '');
  if (p.startsWith('workspace/')) p = p.slice('workspace/'.length);
  p = p.replace(/^(\.\/)+/, '');
  if (!p || p.length > 500 || p.split('/').includes('..')) return null;
  return p;
}

function resolve(
  req: Request,
  res: Response,
): { agentId: string; filePath: string } | null {
  const agent = getAgent(String(req.params.id));
  if (!agent || !ownsResource(req, agent.owner_id)) {
    res.status(404).json({ error: 'Agent not found' });
    return null;
  }
  const filePath = normaliseArtifactPath(req.query.path);
  if (!filePath) {
    res
      .status(400)
      .json({ error: "path query parameter required (the page's file path)" });
    return null;
  }
  return { agentId: agent.id, filePath };
}

function validDocId(res: Response, docId: string): boolean {
  if (!docId || docId.length > MAX_DOC_ID) {
    res
      .status(400)
      .json({ error: `doc id must be 1-${MAX_DOC_ID} characters` });
    return false;
  }
  return true;
}

function parse(json: string): unknown {
  try {
    return JSON.parse(json);
  } catch {
    return null;
  }
}

artifactDocsRouter.get('/agents/:id/artifact-docs', (req, res) => {
  const r = resolve(req, res);
  if (!r) return;
  const docs = listArtifactDocs(r.agentId, r.filePath).map((d) => ({
    id: d.doc_id,
    data: parse(d.data),
    updatedAt: d.updated_at,
  }));
  res.json({ docs });
});

artifactDocsRouter.get('/agents/:id/artifact-docs/:docId', (req, res) => {
  const r = resolve(req, res);
  if (!r || !validDocId(res, req.params.docId)) return;
  const doc = getArtifactDoc(r.agentId, r.filePath, req.params.docId);
  res.json({ id: req.params.docId, data: doc ? parse(doc.data) : null });
});

artifactDocsRouter.put('/agents/:id/artifact-docs/:docId', (req, res) => {
  const r = resolve(req, res);
  if (!r || !validDocId(res, req.params.docId)) return;
  const { data } = (req.body ?? {}) as { data?: unknown };
  if (data === undefined)
    return res.status(400).json({ error: 'data field required' });
  const json = JSON.stringify(data);
  if (Buffer.byteLength(json) > MAX_DOC_BYTES) {
    return res
      .status(413)
      .json({ error: `a document is limited to ${MAX_DOC_BYTES / 1024} KB` });
  }
  const doc = upsertArtifactDoc(r.agentId, r.filePath, req.params.docId, json);
  res.json({ id: doc.doc_id, data, updatedAt: doc.updated_at });
});

artifactDocsRouter.delete('/agents/:id/artifact-docs/:docId', (req, res) => {
  const r = resolve(req, res);
  if (!r || !validDocId(res, req.params.docId)) return;
  deleteArtifactDoc(r.agentId, r.filePath, req.params.docId);
  res.json({ ok: true });
});
