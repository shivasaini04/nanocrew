/**
 * CycleTimeline's "refined timeline" redesign (2026-09-13) — the pinned todo
 * checklist, the loud failure state, and the collapsed repeat-run grouping have no
 * other coverage. Renders the component directly with realistic step shapes
 * (todo_write's real markdown output from todo.py's _render, a failing tool_call in
 * the "Error: ..." house style, a 3+ repeat run) via SSR, the same pattern
 * conversation-view.render.test.ts uses, since there was no browser available to
 * verify this visually when it was written.
 */
import { describe, it, expect } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { CycleTimeline, type TimelineStep } from '../components/CycleTimeline';

function render(steps: TimelineStep[]) {
    return renderToStaticMarkup(createElement(CycleTimeline, { steps, agentColor: '#c2410c' } as never));
}

describe('CycleTimeline refined-timeline behavior', () => {
    it('pins the latest todo list, parsed from the real todo.py markdown shape', () => {
        const html = render([
            {
                id: 't1', name: 'todo_write', args: '{}',
                result: JSON.stringify(
                    '**Todo list**\n\nHIGH\n  ✓ [remove-stale] Remove the 7 stale sections\n  ○ [reclass] Reclassify email risk\n\n1/2 completed, 1 remaining',
                ),
            },
        ]);
        expect(html).toContain('PROGRESS');
        expect(html).toContain('1/2');
        expect(html).toContain('Remove the 7 stale sections');
        expect(html).toContain('Reclassify email risk');
    });

    it('marks a failed tool call loudly, distinct from a successful one', () => {
        const html = render([
            { id: 's1', name: 'python_repl', args: '{"code":"..."}', result: JSON.stringify("Error: KeyError: 'contact_status'") },
            { id: 's2', name: 'python_repl', args: '{"code":"..."}', result: JSON.stringify('Parsed 21/21 sections') },
        ]);
        expect(html).toContain('FAILED');
        expect(html).toContain('KeyError:'); // apostrophe is HTML-escaped in the rendered markup
        expect(html).toContain('contact_status');
    });

    it('collapses 3+ consecutive identical tool calls into one group row', () => {
        const steps: TimelineStep[] = Array.from({ length: 7 }, (_, i) => ({
            id: `g${i}`, name: 'grep_search', args: `{"pattern":"section-${i}"}`, result: JSON.stringify('1 match'),
        }));
        const html = render(steps);
        expect(html).toContain('7');
        expect(html).toContain('grep search');
        expect(html).toContain('collapsed, same pattern');
    });

    it('does not group a run shorter than the threshold', () => {
        const steps: TimelineStep[] = [
            { id: 'a', name: 'read_file', args: '{"path":"a"}', result: JSON.stringify('ok') },
            { id: 'b', name: 'read_file', args: '{"path":"b"}', result: JSON.stringify('ok') },
        ];
        const html = render(steps);
        expect(html).not.toContain('collapsed, same pattern');
    });

    it('renders with no todo_write present at all, unchanged', () => {
        const html = render([
            { id: 'x', name: 'web_search', args: '{"query":"test"}', result: JSON.stringify('results') },
        ]);
        expect(html).not.toContain('PROGRESS');
        expect(html).toContain('web search');
    });
});
