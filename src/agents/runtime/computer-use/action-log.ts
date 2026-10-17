import fs from 'node:fs';
import path from 'node:path';
import type { ActionLogEntry, Step, StepResult } from './types.js';

/** Classify an action step into read / write / external. */
export function classifyStep(step: Step): ActionLogEntry['classification'] {
  if (step.isExternal) return 'external';

  switch (step.action) {
    case 'navigate':
    case 'screenshot':
    case 'wait':
      return 'read';

    case 'type':
    case 'select':
    case 'clear':
      return 'write';

    case 'click':
    case 'right_click':
    case 'double_click':
      // Detect dangerous click targets
      if (step.target) {
        const danger =
          /delete|remove|cancel|close-account|submit|send|pay|confirm|buy/i;
        if (danger.test(step.target)) return 'external';
      }
      return 'write';

    default:
      return 'write';
  }
}

/** Write one action log entry as a NDJSON line. */
export function appendActionLog(logPath: string, entry: ActionLogEntry): void {
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  fs.appendFileSync(logPath, JSON.stringify(entry) + '\n', 'utf-8');
}

/** Build a log entry from a step and its result. */
export function buildLogEntry(
  step: Step,
  result: StepResult,
  runId: string,
  agentId: string,
): ActionLogEntry {
  // Never log credential values — replace with redaction marker
  const loggedText = step.credentialRef ? '[CREDENTIAL_REDACTED]' : step.text;

  return {
    runId,
    agentId,
    step: step.step,
    timestamp: new Date().toISOString(),
    action: {
      type: step.action,
      target: step.target,
      text: loggedText,
      url: step.url,
      key: step.key,
    },
    classification: classifyStep(step),
    approvalStatus: 'auto-approved',
    result: {
      status: result.status,
      urlAfter: result.urlAfter,
      error: result.error,
    },
    operatorVisible: true,
  };
}

/** Get the log file path for a run. */
export function getLogPath(
  agentsDir: string,
  agentId: string,
  runId: string,
): string {
  return path.join(agentsDir, agentId, 'computer-use-logs', `${runId}.ndjson`);
}

/** Read all entries from a log file. */
export function readActionLog(logPath: string): ActionLogEntry[] {
  if (!fs.existsSync(logPath)) return [];
  return fs
    .readFileSync(logPath, 'utf-8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as ActionLogEntry);
}
