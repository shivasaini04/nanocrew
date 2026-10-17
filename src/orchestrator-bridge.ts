/**
 * Orchestrator Bridge
 * Allows API routes to invoke orchestrator-level operations (like resetting a session)
 * without creating circular imports. index.ts registers the callback; routes call it.
 */

type ResetSessionFn = (groupFolder: string) => void;

let _resetSession: ResetSessionFn = () => {};

export function registerSessionReset(fn: ResetSessionFn): void {
  _resetSession = fn;
}

export function resetOrchestratorSession(groupFolder: string): void {
  _resetSession(groupFolder);
}
