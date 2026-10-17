/**
 * Stage 60 phase 3 — the daily per-site limit on approved sends from the user's browser.
 */
import { describe, expect, it } from 'vitest';

import {
  approvedSendsLastDay,
  checkBatch,
  sendsPerDay,
} from './batch-send-limit.js';

const now = Date.parse('2026-09-17T12:00:00Z');
const hoursAgo = (h: number) => new Date(now - h * 3600_000).toISOString();
const row = (
  site: string,
  n: number,
  reply: string,
  respondedAt: string,
  type = 'batch_send_live',
) => ({
  action_type: type,
  action_payload: JSON.stringify({
    site,
    items: Array.from({ length: n }, (_, i) => ({ to: `p${i}` })),
  }),
  user_reply: reply,
  responded_at: respondedAt,
  status: 'responded',
});

describe('sendsPerDay', () => {
  it('has a LinkedIn default and a fallback', () => {
    expect(sendsPerDay('linkedin.com', undefined)).toBe(20);
    expect(sendsPerDay('example.com', undefined)).toBe(30);
  });
  it('takes an override, and survives a malformed one', () => {
    expect(sendsPerDay('linkedin.com', '{"linkedin.com":5}')).toBe(5);
    expect(sendsPerDay('linkedin.com', 'not json')).toBe(20);
  });
});

describe('approvedSendsLastDay', () => {
  it('counts only approved batches on that site inside 24 hours', () => {
    const rows = [
      row('linkedin.com', 8, 'approve', hoursAgo(2)),
      row('linkedin.com', 5, 'approve — looks good', hoursAgo(23)),
      row('linkedin.com', 9, 'reject — too many', hoursAgo(1)),
      row('linkedin.com', 7, 'approve', hoursAgo(25)),
      row('x.com', 4, 'approve', hoursAgo(1)),
      row('linkedin.com', 6, 'approve', hoursAgo(1), 'send_email'),
    ];
    expect(approvedSendsLastDay(rows, 'linkedin.com', now)).toBe(13);
  });
});

describe('checkBatch', () => {
  const rows = [row('linkedin.com', 15, 'approve', hoursAgo(3))];
  it('allows a batch that fits and says what is left', () => {
    expect(checkBatch(rows, 'linkedin.com', 5, now, undefined)).toEqual({
      ok: true,
      limit: 20,
      used: 15,
      remaining: 5,
    });
  });
  it('refuses one that does not', () => {
    const v = checkBatch(rows, 'linkedin.com', 6, now, undefined);
    expect(v.ok).toBe(false);
    expect(v.remaining).toBe(5);
  });
});
