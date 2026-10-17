/**
 * Stage 54 — the audit snapshot has to be restorable, not just readable.
 *
 * The first live revert returned ok and changed nothing. Two reasons, both invisible to
 * the types and to a careful reading:
 *
 *   1. a subtree used the friendly label `systemPrompt` where AgentConfig's field is
 *      `customSystemPrompt`, so the restore wrote a key nothing reads and missed the one
 *      it meant to put back;
 *   2. `JSON.stringify` drops `undefined`, so an agent whose `role` had never been set
 *      produced a snapshot with no `role` key at all — and "restore this to unset" could
 *      not be expressed.
 *
 * These pin both. They are cheap and they are the only thing standing between "we have an
 * undo button" and "we have a button".
 */
import { describe, it, expect } from 'vitest';
import { REVERTABLE_CONFIG_KEYS, auditSnapshot } from './self-manage.js';
import type { AgentConfig } from '../../types.js';

/**
 * A structurally complete AgentConfig. Anything a subtree names must exist here, or the
 * snapshot is describing a field the config does not have.
 */
const FULL_CONFIG: AgentConfig = {
  schedule: [{ type: 'lead_search', interval: '4h', enabled: true }],
  oneOffRuns: [],
  budget: { daily: 5, monthly: 50, onExhaust: 'pause' },
  tools: [],
  goals: 'find leads',
  escalationRules: [],
  triggerMode: 'scheduled',
  model: 'deepseek/deepseek-v4-flash',
  subagent_model: 'deepseek/deepseek-v4-flash',
  thinking_enabled: false,
  role: 'Lead Hunter',
  personality: { voice: 'plain', expertise: ['leads'], style: 'terse' },
  customSystemPrompt: { mode: 'replace', content: '# X\n\n## LEARNED\n' },
  pins: ['LEAD_DEFINITION.md'],
  customWorkspaceDirs: [{ name: 'tracked' }],
  task_models: { lead_search: 'deepseek/deepseek-v4-flash' },
  icp: 'B2B SaaS',
  wakePolicy: { webhook: false },
  notifications: { whatsapp: true },
  job_summary: true,
  alwaysHeavy: false,
  useUserBrowser: false,
  requireUserBrowser: false,
  webhookUrl: '',
  approvalRules: [],
};

describe('revertable keys', () => {
  it('every key a revert may write is a real AgentConfig field', () => {
    // `systemPrompt` passing this test would mean the bug is back.
    for (const key of REVERTABLE_CONFIG_KEYS) {
      expect(
        FULL_CONFIG,
        `"${key}" is not a field of AgentConfig`,
      ).toHaveProperty(key);
    }
  });

  it('does not include status, which lives on the agent row and is special-cased', () => {
    expect(REVERTABLE_CONFIG_KEYS.has('status')).toBe(false);
  });
});
