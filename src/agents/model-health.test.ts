/**
 * Stage 64 phase 3 — a run never starts on a model that certainly cannot answer.
 *
 * What must hold: only a certainly-dead model is swapped, only for a certainly-good one; an
 * unknown status changes nothing; a failed probe never marks anything dead.
 */
import { afterEach, describe, expect, it } from 'vitest';

import {
  _setModelHealthForTest,
  modelStatus,
  refreshModelHealth,
} from './model-health.js';
import { usableModel } from '../services/model-router.js';

afterEach(() => {
  for (const p of ['openrouter', 'deepseek', 'groq', 'gemini', 'moonshot'])
    _setModelHealthForTest(p, null);
});

describe('modelStatus', () => {
  it('unknown until a probe answered — never dead by default', () => {
    expect(modelStatus('openrouter/z-ai/glm-5.3-flash')).toBe('unknown');
    expect(modelStatus('somewhere/else')).toBe('unknown');
  });

  it('listed and funded → ok; not listed → dead; account cannot pay → dead', () => {
    _setModelHealthForTest('openrouter', {
      models: new Set(['z-ai/glm-5.3-flash']),
      funded: true,
    });
    _setModelHealthForTest('deepseek', {
      models: new Set(['deepseek-v4-flash']),
      funded: false,
    });
    expect(modelStatus('openrouter/z-ai/glm-5.3-flash')).toBe('ok');
    expect(modelStatus('openrouter/gone/model')).toBe('dead');
    expect(modelStatus('deepseek/deepseek-v4-flash')).toBe('dead');
  });

  it('a model list that could not be fetched leaves it unknown, not dead', () => {
    _setModelHealthForTest('groq', { models: null, funded: null });
    expect(modelStatus('groq/openai/gpt-oss-120b')).toBe('unknown');
  });
});

describe('usableModel — the swap', () => {
  it('keeps a working model untouched', () => {
    _setModelHealthForTest('openrouter', {
      models: new Set(['z-ai/glm-5.3-flash']),
      funded: true,
    });
    expect(
      usableModel('openrouter/z-ai/glm-5.3-flash', ['openrouter/other']),
    ).toBe('openrouter/z-ai/glm-5.3-flash');
  });

  it('swaps the unfunded platform default for the first known-good candidate', () => {
    _setModelHealthForTest('deepseek', {
      models: new Set(['deepseek-v4-flash']),
      funded: false,
    });
    _setModelHealthForTest('openrouter', {
      models: new Set(['deepseek/deepseek-v4-flash-0731']),
      funded: true,
    });
    expect(
      usableModel('deepseek/deepseek-v4-flash', [
        null,
        'gemini/gemini-3.5-flash',
        'openrouter/deepseek/deepseek-v4-flash-0731',
      ]),
    ).toBe('openrouter/deepseek/deepseek-v4-flash-0731');
  });

  it('a retired model is swapped too (the 5 "model not found" failures)', () => {
    _setModelHealthForTest('openrouter', {
      models: new Set(['z-ai/glm-5.3-flash']),
      funded: true,
    });
    expect(
      usableModel('openrouter/retired/model', [
        'openrouter/z-ai/glm-5.3-flash',
      ]),
    ).toBe('openrouter/z-ai/glm-5.3-flash');
  });

  it('never swaps onto an unknown candidate, and keeps the original when nothing is known-good', () => {
    _setModelHealthForTest('deepseek', {
      models: new Set(['deepseek-v4-flash']),
      funded: false,
    });
    expect(
      usableModel('deepseek/deepseek-v4-flash', ['gemini/gemini-3.5-flash']),
    ).toBe('deepseek/deepseek-v4-flash');
  });

  it('an unknown configured model is never swapped', () => {
    _setModelHealthForTest('openrouter', {
      models: new Set(['z-ai/glm-5.3-flash']),
      funded: true,
    });
    expect(
      usableModel('moonshot/kimi-k2.5', ['openrouter/z-ai/glm-5.3-flash']),
    ).toBe('moonshot/kimi-k2.5');
  });
});

describe('refreshModelHealth', () => {
  it('reads each provider list and balance, and a failing provider stays unknown', async () => {
    process.env.OPENROUTER_API_KEY = 'k';
    process.env.DEEPSEEK_API_KEY = 'k';
    process.env.GROQ_API_KEY = 'k';
    process.env.GEMINI_API_KEY = 'k';
    process.env.MOONSHOT_KIMI_API_KEY = 'k';
    const fake = async (url: string): Promise<Response> => {
      const body = (o: unknown) =>
        new Response(JSON.stringify(o), { status: 200 });
      if (url.includes('openrouter.ai/api/v1/models'))
        return body({ data: [{ id: 'z-ai/glm-5.3-flash' }] });
      if (url.includes('openrouter.ai/api/v1/credits'))
        return body({ data: { total_credits: 10, total_usage: 3 } });
      if (url.includes('api.deepseek.com/models'))
        return body({ data: [{ id: 'deepseek-v4-flash' }] });
      if (url.includes('api.deepseek.com/user/balance'))
        return body({ is_available: false });
      if (url.includes('api.groq.com'))
        return body({ data: [{ id: 'openai/gpt-oss-120b' }] });
      if (url.includes('generativelanguage'))
        return body({ models: [{ name: 'models/gemini-3.5-flash' }] });
      throw new Error('network down'); // moonshot
    };
    await refreshModelHealth(fake as typeof fetch);
    expect(modelStatus('openrouter/z-ai/glm-5.3-flash')).toBe('ok');
    expect(modelStatus('deepseek/deepseek-v4-flash')).toBe('dead');
    expect(modelStatus('groq/llama-3.3-70b-versatile')).toBe('dead');
    expect(modelStatus('groq/openai/gpt-oss-120b')).toBe('ok');
    expect(modelStatus('gemini/gemini-3.5-flash')).toBe('ok');
    expect(modelStatus('moonshot/kimi-k2.5')).toBe('unknown');
  });
});
