/**
 * How a step that talked to the person reads in the trace (stage 60, from live testing).
 *
 * `clarify` and `request_batch_approval` are conversations, not machinery: the agent asked
 * something and the person answered. Rendered like every other tool they showed a JSON
 * blob of options, and once the question card above the input was answered it vanished —
 * so the transcript never said what was asked or what was chosen. The founder's
 * screenshot of exactly that, 2026-09-17, is why this exists.
 *
 * Pure, so it is tested without React.
 */
export interface HumanStepSummary {
    /** What the agent asked, in one line. */
    asked: string;
    /** The answer, 'waiting' while it is still open, or a timeout / refusal note. */
    answer: string;
    state: 'waiting' | 'answered' | 'no-answer' | 'refused';
}

function parse(s: string | undefined): Record<string, unknown> | null {
    if (!s) return null;
    try {
        const v = JSON.parse(s);
        // Tool results sometimes arrive as a JSON string wrapping the JSON object.
        if (typeof v === 'string') return parse(v);
        return v && typeof v === 'object' ? v as Record<string, unknown> : null;
    } catch {
        return null;
    }
}

export function summariseHumanStep(name: string, args: string | undefined, result: string | undefined): HumanStepSummary | null {
    if (name !== 'clarify' && name !== 'request_batch_approval') return null;
    const a = parse(args) ?? {};
    const r = result === undefined ? null : parse(result);

    let asked: string;
    if (name === 'clarify') {
        asked = String(a.question ?? 'a question');
    } else {
        const n = Array.isArray(a.items) ? a.items.length : 0;
        asked = `Approve ${n} × ${String(a.action ?? 'send')} on ${String(a.site ?? 'a site')}`;
    }

    if (result === undefined) return { asked, answer: 'Waiting for your answer', state: 'waiting' };
    if (!r) return { asked, answer: String(result).slice(0, 160), state: 'answered' };

    if (r.timed_out) return { asked, answer: 'No answer in time', state: 'no-answer' };
    if (r.limit_reached) return { asked, answer: String(r.error ?? 'Daily limit reached'), state: 'refused' };
    if (name === 'request_batch_approval') {
        if (r.approved === true) return { asked, answer: `Approved${r.reply && r.reply !== 'approve' ? ` — ${String(r.reply)}` : ''}`, state: 'answered' };
        if (typeof r.reply === 'string') return { asked, answer: `Not approved — ${r.reply}`, state: 'refused' };
        return { asked, answer: String(r.error ?? 'Not approved'), state: 'refused' };
    }
    if (typeof r.reply === 'string') return { asked, answer: r.reply || '(empty answer)', state: 'answered' };
    return { asked, answer: String(r.error ?? r.message ?? 'Asked'), state: r.error ? 'refused' : 'waiting' };
}
