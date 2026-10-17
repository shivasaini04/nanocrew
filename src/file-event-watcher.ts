/**
 * File Event Watcher — NanoCrew (Stage 8 Step 4)
 *
 * Polls workspace directories for file-events.json files written by NanoBot containers.
 * For each event, inserts a record into workspace_files and emits a file:created socket event.
 */

import fs from 'fs';
import path from 'path';
import { logger } from './logger.js';
import { GROUPS_DIR, IPC_POLL_INTERVAL } from './config.js';
import { upsertWorkspaceFile, WorkspaceFileRecord } from './db.js';
import { getSocketIO } from './api/instances.js';

let watcherRunning = false;

interface FileEvent {
  id: string;
  context: string;
  context_id: string;
  chat_jid?: string;
  path: string;
  filename: string;
  extension: string;
  size_bytes: number;
  checksum?: string;
  timestamp: string;
}

/**
 * Scan all workspace roots for file-events.json files (async to avoid blocking event loop).
 * Returns an array of [eventsFilePath, groupDir] pairs.
 */
async function findFileEventFiles(): Promise<
  Array<{ eventsPath: string; groupDir: string }>
> {
  const results: Array<{ eventsPath: string; groupDir: string }> = [];
  if (!fs.existsSync(GROUPS_DIR)) return results;

  async function scanDir(dir: string, depth: number) {
    if (depth > 3) return;
    try {
      const entries = await fs.promises.readdir(dir, { withFileTypes: true });
      const subdirWork: Promise<void>[] = [];
      for (const entry of entries) {
        if (entry.isFile() && entry.name === 'file-events.json') {
          results.push({
            eventsPath: path.join(dir, entry.name),
            groupDir: dir,
          });
        } else if (entry.isDirectory()) {
          subdirWork.push(scanDir(path.join(dir, entry.name), depth + 1));
        }
      }
      await Promise.all(subdirWork);
    } catch {
      /* skip unreadable dirs */
    }
  }

  await scanDir(GROUPS_DIR, 0);
  return results;
}

export function startFileEventWatcher(): void {
  if (watcherRunning) {
    logger.debug('File event watcher already running');
    return;
  }
  watcherRunning = true;

  const processFileEvents = async () => {
    const targets = await findFileEventFiles();
    const io = getSocketIO();

    for (const { eventsPath } of targets) {
      try {
        const raw = fs.readFileSync(eventsPath, 'utf-8');
        const events: FileEvent[] = JSON.parse(raw);
        if (!Array.isArray(events) || events.length === 0) continue;

        for (const ev of events) {
          if (!ev.id || !ev.context || !ev.context_id || !ev.path) continue;

          const now = new Date().toISOString();
          const record: WorkspaceFileRecord = {
            id: ev.id,
            context: ev.context,
            context_id: ev.context_id,
            chat_jid: ev.chat_jid ?? null,
            path: ev.path,
            filename: ev.filename,
            extension: ev.extension ?? null,
            size_bytes: ev.size_bytes ?? null,
            checksum: ev.checksum ?? null,
            created_at: ev.timestamp ?? now,
            modified_at: ev.timestamp ?? now,
          };

          upsertWorkspaceFile(record);
          logger.debug(
            { id: ev.id, path: ev.path, context: ev.context },
            'Workspace file registered',
          );

          // Emit socket event so dashboard can react in real-time
          if (io) {
            io.emit('file:created', {
              id: ev.id,
              context: ev.context,
              contextId: ev.context_id,
              chatJid: ev.chat_jid ?? null,
              path: ev.path,
              filename: ev.filename,
              extension: ev.extension ?? null,
              sizeBytes: ev.size_bytes ?? null,
              createdAt: ev.timestamp ?? now,
            });
          }
        }

        // Clear processed events from the file
        fs.writeFileSync(eventsPath, '[]', 'utf-8');
      } catch (err) {
        logger.error({ eventsPath, err }, 'Error processing file-events.json');
      }
    }

    if (watcherRunning) setTimeout(processFileEvents, IPC_POLL_INTERVAL);
  };

  processFileEvents();
  logger.info('File event watcher started');
}

export function stopFileEventWatcher(): void {
  watcherRunning = false;
}
