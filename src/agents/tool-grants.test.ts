/**
 * What `config.tools` still means, now that there is no per-agent tool allowlist
 * (removed 2026-09-14): every agent has every tool, except the outbound ones its owner
 * has not granted — and declared tools are shown to the model from turn one.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { _initTestDatabase, insertAgent } from '../db.js';
import {
  OUTBOUND_TOOLS,
  resolveAdvertisedTools,
  resolveWithheldTools,
} from './tool-grants.js';
import type { AgentConfig } from '../types.js';

const AGENT = 'agent-tools-1';

function makeAgent(tools: string[]) {
  insertAgent({
    id: AGENT,
    name: 'Crawler',
    type: 'custom',
    status: 'idle',
    workspace: '/tmp/ws',
    identity_version: 1,
    created_at: new Date().toISOString(),
    owner_id: 'me',
    config: {
      schedule: [],
      budget: { daily: 5, monthly: 50, onExhaust: 'pause' },
      tools,
      goals: 'g',
      escalationRules: [],
    } as AgentConfig,
  });
}

beforeEach(() => {
  _initTestDatabase();
});

describe('withheld tools', () => {
  it('withholds only the outbound tools the owner has not granted', () => {
    makeAgent(['linkedin_jobs', 'send_whatsapp']);
    expect(resolveWithheldTools(AGENT)).toEqual(
      [...OUTBOUND_TOOLS].filter((t) => t !== 'send_whatsapp').sort(),
    );
  });

  it('withholds nothing that is not outbound — an undeclared tool is still available', () => {
    // The allowlist's failure: emit_artifact / web_search withheld because never declared.
    makeAgent(['linkedin_jobs']);
    const withheld = resolveWithheldTools(AGENT);
    for (const t of [
      'web_search',
      'emit_artifact',
      'generate_tool',
      'browser',
      'exec',
    ]) {
      expect(withheld, t).not.toContain(t);
    }
  });

  it('withholds nothing from an agent granted every outbound tool', () => {
    makeAgent([...OUTBOUND_TOOLS]);
    expect(resolveWithheldTools(AGENT)).toEqual([]);
  });

  it('withholds every outbound tool from an agent with nothing declared', () => {
    makeAgent([]);
    expect(resolveWithheldTools(AGENT)).toEqual([...OUTBOUND_TOOLS].sort());
  });
});

describe('tools advertised past deferral', () => {
  // 2026-09-10: with DEFERRED_TOOLS=on, Crawler's own source tools started invisible.
  // Asked to call yc_jobs, the model called a tool missing from its schema list; the call
  // leaked out as text and the cycle ended having run nothing — twice in a row.

  it('advertises the tools the owner declared', () => {
    makeAgent(['yc_jobs', 'linkedin_jobs', 'web_search']);
    expect(resolveAdvertisedTools(AGENT)).toEqual([
      'linkedin_jobs',
      'web_search',
      'yc_jobs',
    ]);
  });

  it('is empty, not an error, for an agent with nothing declared', () => {
    makeAgent([]);
    expect(resolveAdvertisedTools(AGENT)).toEqual([]);
  });

  it('is empty for an unknown agent', () => {
    expect(resolveAdvertisedTools('no-such-agent')).toEqual([]);
  });

  it('dedupes and drops junk entries rather than forwarding them', () => {
    makeAgent(['yc_jobs', 'yc_jobs', '', 42 as unknown as string]);
    expect(resolveAdvertisedTools(AGENT)).toEqual(['yc_jobs']);
  });
});
