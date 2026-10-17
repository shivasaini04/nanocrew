/**
 * Stage 61 phase 6 — an Effector step shows its proof verdict (effector/proof.py) as a
 * chip, read even from a truncated stored result.
 */
import { describe, it, expect } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { CycleTimeline, proofOf, type TimelineStep } from '../components/CycleTimeline';

function render(steps: TimelineStep[]) {
    return renderToStaticMarkup(createElement(CycleTimeline, { steps, agentColor: '#c2410c' } as never));
}

const RESULT = JSON.stringify({
    success: true, goal: 'Find the price', extracted_data: { answer: '£51.77' },
    proof: { status: 'verified', checks: [{ check: "'answer' is on the final page", result: 'pass', detail: '£51.77' }], final_url: 'https://b.example/' },
});

describe('proof chip', () => {
    it('reads the verdict and checks from an effector result', () => {
        const p = proofOf(RESULT);
        expect(p?.status).toBe('verified');
        expect(p?.checks[0]).toBe("pass: 'answer' is on the final page");
    });

    it('still reads the verdict when the stored result was truncated', () => {
        const truncated = RESULT.slice(0, RESULT.indexOf('final_url'));
        expect(proofOf(truncated)?.status).toBe('verified');
    });

    it('is null for a result without a proof', () => {
        expect(proofOf('{"ok":true}')).toBeNull();
        expect(proofOf(undefined)).toBeNull();
    });

    it('renders VERIFIED / REFUTED chips on effector steps and nothing on others', () => {
        const refuted = RESULT.replace('"status":"verified"', '"status":"refuted"');
        const html = render([
            { id: 'a', name: 'effector', args: '{"goal":"Find the price"}', result: RESULT },
            { id: 'b', name: 'effector', args: '{"goal":"download"}', result: refuted },
            { id: 'c', name: 'web_fetch', args: '{"url":"x"}', result: '"page text"' },
        ]);
        expect(html).toContain('✓ VERIFIED');
        expect(html).toContain('✗ REFUTED');
        expect((html.match(/VERIFIED|REFUTED|UNVERIFIED/g) ?? []).length).toBe(2);
    });
});
