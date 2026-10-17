import { describe, expect, it } from 'vitest';

import { summariseHumanStep } from './human-steps';

const q = JSON.stringify({ question: 'Which pizza size?', options: [{ label: 'small' }, { label: 'medium' }] });

describe('summariseHumanStep', () => {
    it('ignores ordinary tools', () => {
        expect(summariseHumanStep('web_search', '{}', '[]')).toBeNull();
    });

    it('shows the question while it waits, and the choice once answered', () => {
        expect(summariseHumanStep('clarify', q, undefined)).toEqual({ asked: 'Which pizza size?', answer: 'Waiting for your answer', state: 'waiting' });
        const done = summariseHumanStep('clarify', q, JSON.stringify({ answered: true, reply: '2. medium' }));
        expect(done).toEqual({ asked: 'Which pizza size?', answer: '2. medium', state: 'answered' });
    });

    it('unwraps a result that is a JSON string of JSON', () => {
        const wrapped = JSON.stringify(JSON.stringify({ answered: true, reply: '1. small' }));
        expect(summariseHumanStep('clarify', q, wrapped)?.answer).toBe('1. small');
    });

    it('says when nobody answered', () => {
        expect(summariseHumanStep('clarify', q, JSON.stringify({ timed_out: true }))?.state).toBe('no-answer');
    });

    it('summarises a batch approval and its outcome', () => {
        const args = JSON.stringify({ site: 'linkedin.com', action: 'connection request', items: [{ to: 'A' }, { to: 'B' }] });
        expect(summariseHumanStep('request_batch_approval', args, JSON.stringify({ approved: true, reply: 'approve' })))
            .toEqual({ asked: 'Approve 2 × connection request on linkedin.com', answer: 'Approved', state: 'answered' });
        expect(summariseHumanStep('request_batch_approval', args, JSON.stringify({ approved: false, reply: 'reject — shorter notes' }))?.answer)
            .toBe('Not approved — reject — shorter notes');
        expect(summariseHumanStep('request_batch_approval', args, JSON.stringify({ approved: false, limit_reached: true, error: 'Daily limit for linkedin.com' }))?.state)
            .toBe('refused');
    });
});
