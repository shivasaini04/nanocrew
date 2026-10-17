import { describe, it, expect } from 'vitest';
import { normaliseTrackerSchema, normaliseSchedule } from './agent-service.js';

/**
 * These parse JSON an LLM wrote from a conversation, so the cases that matter are the
 * sloppy ones. The guiding rule: never fail a hire the user already approved — degrade
 * to "no tracker" rather than throwing, and coerce anything coercible.
 */
describe('normaliseTrackerSchema', () => {
  it('accepts a well-formed schema unchanged', () => {
    const s = normaliseTrackerSchema({
      name: 'Lead',
      namePlural: 'Leads',
      stages: [{ key: 'qualified', label: 'Qualified', color: '#22c55e' }],
      fields: [{ key: 'handle', label: 'Handle', type: 'text' }],
    });
    expect(s?.name).toBe('Lead');
    expect(s?.stages[0]).toEqual({
      key: 'qualified',
      label: 'Qualified',
      color: '#22c55e',
    });
    expect(s?.fields[0].type).toBe('text');
  });

  it('accepts stages and fields written as bare strings', () => {
    const s = normaliseTrackerSchema({
      name: 'Lead',
      stages: ['Qualified', 'Contacted'],
      fields: ['Handle', 'Their task'],
    });
    expect(s?.stages.map((x) => x.key)).toEqual(['qualified', 'contacted']);
    expect(s?.fields.map((x) => x.key)).toEqual(['handle', 'their_task']);
    expect(s?.stages.every((x) => /^#[0-9a-f]{6}$/i.test(x.color))).toBe(true);
  });

  it('accepts snake_case name_plural and derives one when missing', () => {
    expect(
      normaliseTrackerSchema({
        name: 'Lead',
        name_plural: 'Leadz',
        stages: ['a'],
        fields: ['b'],
      })?.namePlural,
    ).toBe('Leadz');
    expect(
      normaliseTrackerSchema({ name: 'Lead', stages: ['a'], fields: ['b'] })
        ?.namePlural,
    ).toBe('Leads');
  });

  it('coerces an invented field type to text rather than dropping the field', () => {
    const s = normaliseTrackerSchema({
      name: 'L',
      stages: ['a'],
      fields: [{ key: 'k', label: 'K', type: 'currency' }],
    });
    expect(s?.fields[0].type).toBe('text');
  });

  it('replaces a malformed colour with a palette default', () => {
    const s = normaliseTrackerSchema({
      name: 'L',
      stages: [{ key: 's', label: 'S', color: 'green' }],
      fields: ['f'],
    });
    expect(s?.stages[0].color).toMatch(/^#[0-9a-f]{6}$/i);
  });

  it('returns undefined rather than a half-built board', () => {
    expect(normaliseTrackerSchema(undefined)).toBeUndefined();
    expect(normaliseTrackerSchema('Leads')).toBeUndefined();
    expect(
      normaliseTrackerSchema({ name: 'Lead', stages: [], fields: ['a'] }),
    ).toBeUndefined();
    expect(
      normaliseTrackerSchema({ name: 'Lead', stages: ['a'], fields: [] }),
    ).toBeUndefined();
    expect(
      normaliseTrackerSchema({ stages: ['a'], fields: ['b'] }),
    ).toBeUndefined();
  });
});

describe('normaliseSchedule', () => {
  it('keeps a valid multi-entry schedule', () => {
    const s = normaliseSchedule(
      [
        { type: 'work', interval: '0 3 * * *' },
        { type: 'checkin', interval: '24h', enabled: false },
      ],
      '24h',
    );
    expect(s).toHaveLength(2);
    expect(s[0]).toEqual({
      type: 'work',
      interval: '0 3 * * *',
      enabled: true,
    });
    expect(s[1].enabled).toBe(false);
  });

  it('drops entries with an unknown cycle type or no interval', () => {
    const s = normaliseSchedule(
      [{ type: 'nonsense', interval: '24h' }, { type: 'work' }],
      '12h',
    );
    expect(s).toEqual([{ type: 'custom', interval: '12h', enabled: true }]);
  });

  it('falls back to the single-interval form when no array is given', () => {
    expect(normaliseSchedule(undefined, '6h')).toEqual([
      { type: 'custom', interval: '6h', enabled: true },
    ]);
  });
});
