/**
 * Stage 60 phase 2 — a clarify check-in parses into a question with options, and a
 * legacy row (markdown only) still parses into something answerable.
 */
import { describe, it, expect } from 'vitest';
import { parseQuestion } from '../components/QuestionCard';

describe('parseQuestion', () => {
    it('reads the structured question', () => {
        const q = parseQuestion({
            action_payload: JSON.stringify({
                awaitUntil: 123, question: 'LinkedIn or job boards?', context: 'read the site',
                options: [{ label: 'LinkedIn', detail: 'your browser' }, { label: '' }, { nope: 1 }, { label: 'Job boards' }],
                multi_select: true,
            }),
        });
        expect(q.question).toBe('LinkedIn or job boards?');
        expect(q.context).toBe('read the site');
        expect(q.options.map(o => o.label)).toEqual(['LinkedIn', 'Job boards']);
        expect(q.multi).toBe(true);
        expect(q.awaitUntil).toBe(123);
    });

    it('degrades to a free-text question for a legacy or broken payload', () => {
        for (const action_payload of [JSON.stringify({ awaitUntil: 5 }), 'not json', null]) {
            const q = parseQuestion({ report_md: '## Question\n\nWhich email?', action_payload });
            expect(q.question).toBeNull();
            expect(q.options).toEqual([]);
            expect(q.multi).toBe(false);
        }
    });
});
