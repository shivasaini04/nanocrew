/**
 * What a timer-started run is actually told. The feature is only as good as this text:
 * before 2026-09-24 every timer said "Today is <date>. Run your work cycle now." — no time,
 * no job — and an agent with three jobs had to guess.
 */
import { describe, it, expect } from 'vitest';
import { buildCyclePrompt } from './nanobot-cycle-runner.js';
import type { AgentConfig } from '../types.js';

const config = {
  schedule: [],
  budget: { daily: 5, monthly: 50, onExhaust: 'pause' },
  tools: [],
  goals: 'Keep the ops log and report on it',
  escalationRules: [],
} as AgentConfig;

describe('timer prompt', () => {
  const prompt = buildCyclePrompt({
    cycleType: 'work',
    config,
    timer: {
      id: 'report',
      name: '9 AM report',
      instruction: 'Build report.xlsx from the log and message me.',
      timezone: 'Asia/Kolkata',
      interval: '0 9 * * *',
      firedAt: '2026-09-24T03:30:00.000Z',
      lastRun: {
        at: '2026-09-23T03:31:00.000Z',
        status: 'completed',
        summary: 'Built report with 42 rows',
      },
    },
  });

  it("opens with the time on the timer's own clock, and in UTC", () => {
    expect(prompt.split('\n')[0]).toContain('09:00 (Asia/Kolkata)');
    expect(prompt.split('\n')[0]).toContain('2026-09-24 03:30 UTC');
  });

  it('names the timer and gives its task, not a generic work cycle', () => {
    expect(prompt).toContain('"9 AM report"');
    expect(prompt).toContain(
      "## This timer's task\nBuild report.xlsx from the log and message me.",
    );
    expect(prompt).not.toContain('Run your work work cycle now');
    expect(prompt).not.toMatch(/Today is \d{4}-\d{2}-\d{2}\. Run your/);
  });

  it('tells it how the last run of this timer went', () => {
    expect(prompt).toContain('completed: Built report with 42 rows');
  });

  it('still carries the mission', () => {
    expect(prompt).toContain('Your mission: Keep the ops log and report on it');
  });
});
