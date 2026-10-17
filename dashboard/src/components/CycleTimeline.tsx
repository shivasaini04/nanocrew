import { summariseHumanStep } from '../lib/human-steps';
import React, { useState, useEffect } from 'react';
import ReactMarkdown from 'react-markdown';
import type { Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { CR } from '../lib/cr';
import { JsonViewer } from './JsonViewer';

/**
 * CycleTimeline — the ONE shared "agent working" thread.
 *
 * Renders the vertical thread of thinking + tool steps (each tool with a
 * collapsible "N lines of output" block), closed by either a live working node
 * (isActive) or a final-answer node (finished). Used by:
 *   - StreamingTurn      → live streaming, both chats   (isActive)
 *   - BotTurn            → project chat finished turns
 *   - AgentProfilePage   → agent chat finished turns
 *
 * Callers own the avatar / name / per-page wrappers; this owns the thread only.
 *
 * Redesigned per the "refined timeline" direction picked 2026-09-13 (agent-cycle
 * trace UI review): card-style tool steps instead of a text line, a failure state
 * that's loud instead of indistinguishable from success, consecutive identical
 * tool calls collapsed into one row instead of N, and the latest todo_write kept
 * visible above the thread instead of scrolling out of view the moment the next
 * step runs (a normal block, not position:sticky — that only ever stuck within
 * this one turn's own box, not the viewport, once seen live). Second pass same
 * day: the thinking icon was dropped (it competed with the card icons for the
 * same job the italic label already does) and every `<details>` toggle got an
 * explicit chevron — the original had a "thinking" block whose long text just
 * stopped mid-word with no visible sign there was more to see.
 *
 * Per-step duration and a running cost ticker were part of that
 * mockup too but aren't rendered here — TimelineStep carries no timestamp or
 * cost field today, and inventing numbers would be worse than omitting them;
 * that needs cycle_steps.created_at / agent_cycles.cost threaded down from each
 * call site first.
 */

const THINKING_PHRASES = ['thinking', 'reasoning', 'analyzing', 'planning', 'figuring it out', 'working it through'];

const TOOL_ICONS: Record<string, string> = {
    read_file: '📄', write_file: '✏️', list_files: '📂', list_dir: '📂',
    glob_search: '🔍', grep_search: '🔍',
    web_search: '🌐', web_fetch: '🌐', browser: '🌐',
    exec: '⚡', python_repl: '⚡', run_tests: '🧪',
    search_memory: '🧠', append_memory: '💾', search_crew_memory: '🧠',
    handoff_to: '🔀', send_message_to_agent: '📨', spawn_agent: '🤖', spawn: '🤖',
    enter_plan_mode: '📋', todo_write: '📋',
    thinking: '💭',
};

const TOOL_PHRASE: Record<string, string> = {
    read_file: 'reading', read_image: 'reading', read_pdf: 'reading', read_bulletin: 'reading', list_dir: 'reading',
    glob_search: 'searching files', grep_search: 'searching files',
    write_file: 'writing', edit_file: 'editing', append_file: 'writing', emit_artifact: 'creating',
    exec: 'running', python_repl: 'running', run_tests: 'testing', git: 'running git', github_api: 'calling GitHub',
    web_search: 'searching the web', web_fetch: 'fetching a page', url_check: 'checking links',
    hn_search: 'searching the web',
    search_memory: 'recalling', search_crew_memory: 'recalling crew memory', search_knowledge: 'recalling',
    tool_search: 'loading tools', generate_tool: 'building a tool', update_tool: 'updating a tool',
    enter_plan_mode: 'planning', exit_plan_mode: 'planning', todo_write: 'planning',
    message: 'composing', handoff_to: 'handing off', send_message_to_agent: 'messaging the crew',
    gmail_send: 'sending email', gmail_check_replies: 'checking email', browser: 'browsing',
    sql_query: 'querying data', http_request: 'calling an API', request_approval: 'requesting approval',
    save_skill: 'saving a skill', spawn: 'spawning a helper', spawn_agent: 'spawning an agent',
    delegate_task: 'delegating', sleep: 'waiting',
};

/** Copy-to-clipboard affordance for a finished answer — appears subtly, brightens on hover. */
function CopyButton({ text }: { text: string }) {
    const [copied, setCopied] = useState(false);
    return (
        <button
            onClick={() => { navigator.clipboard.writeText(text); setCopied(true); setTimeout(() => setCopied(false), 1500); }}
            title="Copy"
            style={{ marginTop: 6, background: 'none', border: 'none', cursor: 'pointer', fontSize: 11, padding: 0, color: copied ? 'var(--cr-green)' : CR.muted, transition: 'color 0.2s', opacity: 0.7 }}
            onMouseEnter={e => { e.currentTarget.style.opacity = '1'; if (!copied) e.currentTarget.style.color = CR.sub; }}
            onMouseLeave={e => { e.currentTarget.style.opacity = '0.7'; if (!copied) e.currentTarget.style.color = CR.muted; }}
        >{copied ? '✓ copied' : '⎘ copy'}</button>
    );
}

function phraseForTool(name?: string): string {
    if (!name || name === 'thinking') return 'thinking';
    const exact = TOOL_PHRASE[name];
    if (exact) return exact;
    const n = name.toLowerCase();
    if (/write|create|generat/.test(n)) return 'creating';
    if (/edit|patch/.test(n)) return 'editing';
    if (/run|exec|bash|shell|command|test/.test(n)) return 'running';
    if (/search|find|query|lookup/.test(n)) return 'searching';
    if (/read|view|list|glob|grep|fetch/.test(n)) return 'reading';
    if (/memory|recall|knowledge/.test(n)) return 'recalling';
    if (/plan|todo/.test(n)) return 'planning';
    if (/message|send|reply|compose|mail/.test(n)) return 'composing';
    return 'working';
}

/** Normalized step shape — accepts both live tools ({id}) and persisted trace (no id). */
export interface TimelineStep {
    id?: string;
    name: string;
    args: string;
    result?: string;
}

/** Unwrap a step's JSON-or-plain result into a display string — the same "try JSON,
 *  fall back to raw" rule used throughout this file, pulled out once so the failure
 *  check, the todo parser and the card body all read the same text. */
function unwrapResult(result: string | undefined): string {
    if (result === undefined) return '';
    try { const r = JSON.parse(result); return typeof r === 'string' ? r : JSON.stringify(r, null, 2); }
    catch { return result; }
}

/**
 * Heuristic failure check. TimelineStep carries no explicit success/failure field —
 * there is nothing upstream recording one per tool call today — so this reads the
 * same signals a person scanning the text would: the "Error: …" prefix most tools
 * in this codebase use for a failed call (read_file's "Error: File not found: …" is
 * the one we watched happen live this session), a Python traceback, or a JSON
 * {error: …} shape. False negatives are possible (a tool that fails silently in
 * prose); a real fix is a status field written at the source, not a smarter regex.
 */
function isFailedResult(resStr: string): boolean {
    if (!resStr) return false;
    const head = resStr.slice(0, 200).trim();
    if (/^error[:\s]/i.test(head)) return true;
    if (/traceback \(most recent call last\)/i.test(head)) return true;
    try {
        const parsed = JSON.parse(resStr);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed) && 'error' in parsed && parsed.error) return true;
    } catch { /* not JSON, already checked as text above */ }
    return false;
}

interface TodoItem { id: string; status: string; content: string; }

const TODO_ICON_TO_STATUS: Record<string, string> = { '○': 'pending', '◐': 'in_progress', '✓': 'completed', '✗': 'cancelled' };

/** todo_write's result is the rendered markdown list todo.py's _render() produces
 *  ("  ○ [id] content" per line under a priority heading), not structured JSON —
 *  parse that fixed shape rather than guess at a schema that doesn't exist. */
function parseTodoResult(resStr: string): TodoItem[] | null {
    if (!resStr || !resStr.includes('[')) return null;
    const items: TodoItem[] = [];
    const lineRe = /^\s*([○◐✓✗])\s+\[([^\]]+)\]\s+(.*)$/gm;
    let m: RegExpExecArray | null;
    while ((m = lineRe.exec(resStr))) {
        items.push({ id: m[2], status: TODO_ICON_TO_STATUS[m[1]] ?? 'pending', content: m[3].trim() });
    }
    return items.length > 0 ? items : null;
}

/** The most recent todo_write call's list, so the checklist reflects where the
 *  agent currently stands rather than the plan it started with. */
function findLatestTodoList(steps: TimelineStep[]): TodoItem[] | null {
    for (let i = steps.length - 1; i >= 0; i--) {
        const s = steps[i];
        if (s.name === 'todo_write' && s.result !== undefined) {
            const parsed = parseTodoResult(unwrapResult(s.result));
            if (parsed) return parsed;
        }
    }
    return null;
}

/** Shown above the thread whenever a todo_write has run. Not pinned/sticky — that
 *  only ever stuck within this one turn's own box, not the viewport, since this
 *  component renders per-turn inside a scrolling feed rather than as one page-level
 *  overlay. A normal block in reading order (plan, then the steps that carried it
 *  out) is both simpler and matches how someone actually reads a turn top to bottom. */
function TodoChecklist({ items, accentColor }: { items: TodoItem[]; accentColor: string }) {
    const done = items.filter(t => t.status === 'completed').length;
    return (
        <div style={{
            marginBottom: 6,
            background: CR.bgCard, border: `1px solid ${CR.border}`, borderRadius: 8,
            padding: '10px 12px',
        }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                <span style={{ fontFamily: CR.mono, fontSize: 9.5, fontWeight: 700, color: CR.muted, letterSpacing: '0.08em' }}>
                    PROGRESS · {done}/{items.length}
                </span>
                <div style={{ flex: 1, height: 3, background: 'var(--cr-tint-3)', borderRadius: 2, overflow: 'hidden' }}>
                    <div style={{ width: `${(done / items.length) * 100}%`, height: '100%', background: accentColor, transition: 'width 0.3s' }} />
                </div>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                {items.map(t => {
                    const isDone = t.status === 'completed';
                    const isCancelled = t.status === 'cancelled';
                    const isActive = t.status === 'in_progress';
                    return (
                        <div key={t.id} style={{ display: 'flex', alignItems: 'flex-start', gap: 7, opacity: isDone || isCancelled ? 0.5 : 1 }}>
                            <span style={{
                                fontSize: 11, flexShrink: 0, marginTop: 1, lineHeight: 1,
                                color: isDone ? 'var(--cr-green)' : isCancelled ? 'var(--cr-error)' : isActive ? accentColor : CR.muted,
                            }}>
                                {isDone ? '✓' : isCancelled ? '✗' : isActive ? '◐' : '○'}
                            </span>
                            <span style={{
                                fontFamily: CR.sans, fontSize: 12, lineHeight: 1.4,
                                color: isActive ? CR.cream : CR.sub, fontWeight: isActive ? 600 : 400,
                                textDecoration: isDone || isCancelled ? 'line-through' : 'none',
                                textDecorationColor: 'rgba(255,255,255,0.25)',
                            }}>{t.content}</span>
                        </div>
                    );
                })}
            </div>
        </div>
    );
}

/** CSS for every `<details className="cr-expand">` in this file — hides the native
 *  disclosure marker (both engines use a different mechanism) and rotates the
 *  explicit chevron this file draws instead, so "click to expand" is visible rather
 *  than the old behavior of text just stopping mid-word with no sign anything else
 *  was there. */
const EXPAND_CSS = `
details.cr-expand > summary { list-style: none; }
details.cr-expand > summary::-webkit-details-marker { display: none; }
details.cr-expand[open] > summary .cr-chevron { transform: rotate(90deg); }
`;

function Chevron() {
    return (
        <span className="cr-chevron" style={{ display: 'inline-flex', color: CR.muted, flexShrink: 0, marginTop: 3, transition: 'transform 0.15s' }}>
            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={3} strokeLinecap="round" strokeLinejoin="round">
                <path d="M9 18l6-6-6-6" />
            </svg>
        </span>
    );
}

/** One tool call, card-style: icon box, name, one-line arg preview, a status dot,
 *  and — the thing the old inline-text version never showed — a loud failed state
 *  whose error text is visible even collapsed, not hidden behind the chevron. */
// Stage 61 phase 6: an Effector result carries `proof` — whether the result was checked
// independently of the agent's own "done" (effector/proof.py). Read with a pattern rather
// than JSON.parse: stored tool results can be truncated, which breaks a full parse but
// leaves the verdict near the end intact. Returns null for any other tool.
export type ProofVerdict = { status: 'verified' | 'unknown' | 'refuted'; checks: string[] };
export function proofOf(result: string | undefined): ProofVerdict | null {
    if (!result) return null;
    const m = result.match(/"proof"\s*:\s*\{\s*"status"\s*:\s*"(verified|unknown|refuted)"/);
    if (!m) return null;
    const checks: string[] = [];
    const re = /"check"\s*:\s*"((?:[^"\\]|\\.)*)"\s*,\s*"result"\s*:\s*"((?:[^"\\]|\\.)*)"/g;
    let c: RegExpExecArray | null;
    while ((c = re.exec(result)) !== null && checks.length < 8) checks.push(`${c[2]}: ${c[1]}`);
    return { status: m[1] as ProofVerdict['status'], checks };
}

const PROOF_STYLE: Record<ProofVerdict['status'], { label: string; color: string; bg: string }> = {
    verified: { label: '✓ VERIFIED', color: 'var(--cr-green)', bg: 'rgba(34,197,94,0.10)' },
    unknown: { label: '? UNVERIFIED', color: 'var(--cr-muted)', bg: 'var(--cr-tint-3)' },
    refuted: { label: '✗ REFUTED', color: 'var(--cr-error)', bg: 'var(--cr-error-low)' },
};

function ProofChip({ proof }: { proof: ProofVerdict }) {
    const st = PROOF_STYLE[proof.status];
    const tip = proof.checks.length ? proof.checks.join(' · ') : 'Nothing checkable was produced';
    return (
        <span title={tip} style={{ fontFamily: CR.mono, fontSize: 9, fontWeight: 700, color: st.color, background: st.bg, borderRadius: 4, padding: '1px 6px', letterSpacing: '0.05em' }}>
            {st.label}
        </span>
    );
}

function ToolCard({ t, agentColor, isActive }: { t: TimelineStep; agentColor: string; isActive: boolean }) {
    const icon = TOOL_ICONS[t.name] || '⚙️';
    const done = t.result !== undefined;

    let argSummary = '';
    try {
        const a = JSON.parse(t.args || '{}');
        // Both branches must cap length — a non-string value (e.g. a tools array on
        // create_agent) went through JSON.stringify with no limit, producing one long,
        // barely-breakable line that overflowed the chat bubble and, since the scroll
        // container has no overflowX guard, dragged the whole pane into horizontal
        // scroll instead of just this one line.
        argSummary = Object.entries(a).map(([, v]) => {
            const s = typeof v === 'string' ? v.replace(/\s+/g, ' ') : JSON.stringify(v);
            return s.length > 72 ? s.slice(0, 72) + '…' : s;
        }).join(' · ');
    } catch { /* args not JSON — leave blank */ }

    // Stage 60: a question to the person reads as the question and the answer, not JSON.
    const human = summariseHumanStep(t.name, t.args, t.result);
    if (human) argSummary = human.asked;

    const resStr = done ? unwrapResult(t.result) : '';
    const failed = done && isFailedResult(resStr) && human?.state !== 'answered';
    const proof = done ? (proofOf(t.result) ?? proofOf(resStr)) : null;
    const lineCount = resStr ? resStr.split('\n').length : 0;

    let fullArgsStr = '';
    let structuredArgs: unknown;
    if (t.args && t.args.trim() && t.args.trim() !== '{}') {
        try {
            const parsed = JSON.parse(t.args);
            fullArgsStr = JSON.stringify(parsed, null, 2);
            if (parsed && typeof parsed === 'object') structuredArgs = parsed;
        } catch { fullArgsStr = t.args; }
    }
    // A structured result (an object/array, not prose) gets the same collapsible,
    // syntax-highlighted tree the Files page already uses for JSON — a flat grey
    // <pre> dump of a nested object was the thing being fixed here. Prose results
    // (todo_write's markdown list, a multi-line log) keep the <pre>: JsonViewer
    // prints a top-level string as one quoted, unwrapped line, which is worse for
    // anything with real line breaks. Capped by size so one huge payload can't
    // render thousands of DOM nodes — falls back to the same <pre> at that point.
    let structuredResult: unknown;
    if (done) {
        try {
            const parsed = JSON.parse(t.result ?? '""');
            if (parsed && typeof parsed === 'object' && resStr.length < 20000) structuredResult = parsed;
        } catch { /* not JSON, or already plain text — resStr covers it */ }
    }

    const statusColor = failed ? 'var(--cr-error)' : done ? 'var(--cr-green)' : agentColor;
    const cardBorder = failed ? 'var(--cr-error-line)' : CR.border;

    const expandable = !!(fullArgsStr || resStr);

    return (
        <details className="cr-expand">
            <summary style={{
                listStyle: 'none', cursor: expandable ? 'pointer' : 'default', display: 'flex', alignItems: 'flex-start', gap: 10,
                background: failed ? 'var(--cr-error-low)' : CR.bgCard,
                border: `1px solid ${cardBorder}`,
                borderLeft: failed ? '3px solid var(--cr-error)' : `1px solid ${cardBorder}`,
                borderRadius: 8, padding: '9px 11px',
            }}>
                <span style={{
                    width: 26, height: 26, borderRadius: 6, background: 'var(--cr-tint-3)',
                    display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 13, flexShrink: 0,
                }}>{icon}</span>
                <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ display: 'flex', alignItems: 'baseline', gap: 7, flexWrap: 'wrap' }}>
                        <span style={{ fontFamily: CR.mono, fontSize: 11.5, fontWeight: 700, color: CR.text }}>{t.name.replace(/_/g, ' ')}</span>
                        {failed && (
                            <span style={{ fontFamily: CR.mono, fontSize: 9, fontWeight: 700, color: 'var(--cr-error)', background: 'var(--cr-error-low)', borderRadius: 4, padding: '1px 6px', letterSpacing: '0.05em' }}>
                                FAILED
                            </span>
                        )}
                        {proof && <ProofChip proof={proof} />}
                        {argSummary && <span style={{ fontFamily: CR.mono, fontSize: 11, color: CR.muted, wordBreak: 'break-word', overflowWrap: 'anywhere', minWidth: 0 }}>{argSummary}</span>}
                        {isActive && !done && <span style={{ color: CR.muted, animation: 'crewBlink 1s infinite', fontSize: 12 }}>⋯</span>}
                    </div>
                    {human ? (
                        <div style={{ fontFamily: CR.sans, fontSize: 12, marginTop: 4, color: human.state === 'answered' ? CR.text : human.state === 'waiting' ? agentColor : CR.muted }}>
                            {human.state === 'answered' ? '→ You answered: ' : human.state === 'waiting' ? '… ' : '→ '}{human.answer}
                        </div>
                    ) : failed ? (
                        <div style={{ fontFamily: CR.mono, fontSize: 10, color: 'var(--cr-error)', marginTop: 3 }}>{resStr.slice(0, 160)}</div>
                    ) : done ? (
                        <div style={{ fontFamily: CR.mono, fontSize: 9.5, color: CR.muted, marginTop: 3 }}>{lineCount} line{lineCount !== 1 ? 's' : ''} of output</div>
                    ) : null}
                </div>
                <span style={{ width: 8, height: 8, borderRadius: '50%', background: statusColor, flexShrink: 0, marginTop: 4 }} />
                {expandable && <Chevron />}
            </summary>
            {/* Flush with the card above it, not indented 36px to clear the icon box —
                that made the expanded panel narrower and left-shifted relative to the
                summary it belongs to instead of reading as one continuous block. */}
            {(fullArgsStr || resStr) && (
                <div style={{ marginTop: 5, border: `1px solid ${CR.border}`, borderRadius: 6, background: CR.bgMain, overflow: 'hidden' }}>
                    {fullArgsStr && (
                        <div style={{ padding: '7px 9px' }}>
                            <div style={{ fontFamily: CR.mono, fontSize: 8.5, color: CR.muted, textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 3 }}>Arguments</div>
                            {structuredArgs !== undefined ? (
                                <JsonViewer data={structuredArgs} />
                            ) : (
                                <pre style={{ fontFamily: CR.mono, fontSize: 10, color: CR.sub, margin: 0, whiteSpace: 'pre-wrap', wordBreak: 'break-word', maxHeight: 220, overflowY: 'auto' }}>
                                    {fullArgsStr.slice(0, 4000)}{fullArgsStr.length > 4000 ? '\n…' : ''}
                                </pre>
                            )}
                        </div>
                    )}
                    {fullArgsStr && resStr && <div style={{ borderTop: `1px solid ${CR.border}` }} />}
                    {resStr && (
                        <div style={{ padding: '7px 9px' }}>
                            <div style={{ fontFamily: CR.mono, fontSize: 8.5, color: CR.muted, textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 3 }}>Result</div>
                            {structuredResult !== undefined ? (
                                <JsonViewer data={structuredResult} />
                            ) : (
                                <pre style={{ fontFamily: CR.mono, fontSize: 10, color: failed ? 'var(--cr-error)' : CR.muted, margin: 0, whiteSpace: 'pre-wrap', wordBreak: 'break-word', maxHeight: 220, overflowY: 'auto' }}>
                                    {resStr.slice(0, 4000)}{resStr.length > 4000 ? '\n…' : ''}
                                </pre>
                            )}
                        </div>
                    )}
                </div>
            )}
        </details>
    );
}

type RenderItem =
    | { kind: 'thinking'; step: TimelineStep; key: string }
    | { kind: 'tool'; step: TimelineStep; key: string }
    | { kind: 'group'; name: string; items: TimelineStep[]; key: string };

// 3+ consecutive calls to the same tool collapse into one row — the fix for a
// 100+ step cycle turning into an unreadable wall of near-identical cards (watched
// live this session: 7 grep_search calls in a row locating stale sections).
const GROUP_THRESHOLD = 3;

function groupSteps(steps: TimelineStep[]): RenderItem[] {
    const out: RenderItem[] = [];
    let i = 0;
    while (i < steps.length) {
        const s = steps[i];
        if (s.name === 'thinking') { out.push({ kind: 'thinking', step: s, key: s.id ?? `t${i}` }); i++; continue; }
        let j = i + 1;
        while (j < steps.length && steps[j].name === s.name) j++;
        if (j - i >= GROUP_THRESHOLD) {
            out.push({ kind: 'group', name: s.name, items: steps.slice(i, j), key: `g${i}` });
        } else {
            for (let k = i; k < j; k++) out.push({ kind: 'tool', step: steps[k], key: steps[k].id ?? `s${k}` });
        }
        i = j;
    }
    return out;
}

/** Collapsed run of identical calls — a dashed placeholder row that expands to the
 *  same ToolCards it stands in for, so nothing is actually hidden, just deferred. */
function GroupRow({ name, items, agentColor, isActive }: { name: string; items: TimelineStep[]; agentColor: string; isActive: boolean }) {
    const icon = TOOL_ICONS[name] || '⚙️';
    const failedCount = items.filter(t => t.result !== undefined && isFailedResult(unwrapResult(t.result))).length;
    return (
        <details className="cr-expand">
            <summary style={{
                listStyle: 'none', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 10,
                background: CR.bgCard, border: `1px dashed ${CR.border}`, borderRadius: 8, padding: '9px 11px',
            }}>
                <span style={{
                    width: 26, height: 26, borderRadius: 6, background: 'var(--cr-tint-3)',
                    display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 13, flexShrink: 0,
                }}>{icon}</span>
                <div style={{ flex: 1, minWidth: 0 }}>
                    <span style={{ fontFamily: CR.mono, fontSize: 11.5, fontWeight: 700, color: CR.text }}>
                        {items.length}× {name.replace(/_/g, ' ')}
                    </span>
                    <span style={{ fontFamily: CR.mono, fontSize: 11, color: CR.muted, marginLeft: 7 }}>— collapsed, same pattern</span>
                    {failedCount > 0 && (
                        <span style={{ fontFamily: CR.mono, fontSize: 9, fontWeight: 700, color: 'var(--cr-error)', background: 'var(--cr-error-low)', borderRadius: 4, padding: '1px 6px', marginLeft: 7 }}>
                            {failedCount} FAILED
                        </span>
                    )}
                </div>
                <Chevron />
            </summary>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 6, marginLeft: 12 }}>
                {items.map((t, k) => <ToolCard key={t.id ?? k} t={t} agentColor={agentColor} isActive={isActive} />)}
            </div>
        </details>
    );
}

// ─── Web sources (References) ─────────────────────────────────────────────────
// Web-fetch / browser steps carry a URL in their args; surface them as source chips
// under a finished turn. Pure function of the trace, so both chats get it for free.

function SourceChip({ index, url }: { index: number; url: string }) {
    let host = url;
    try { host = new URL(url).hostname.replace('www.', ''); } catch { /* leave as-is */ }
    return (
        <a href={url} target="_blank" rel="noopener noreferrer"
            style={{ display: 'inline-flex', alignItems: 'center', gap: '6px', padding: '4px 10px', borderRadius: '100px', background: 'var(--cr-tint-1)', border: '1px solid var(--cr-border)', textDecoration: 'none', color: 'var(--cr-muted)', fontSize: '11px', fontFamily: 'var(--cr-font-sans)', transition: 'all 0.15s' }}
            onMouseEnter={e => { e.currentTarget.style.borderColor = 'var(--cr-accent)'; e.currentTarget.style.color = 'var(--cr-sub)'; }}
            onMouseLeave={e => { e.currentTarget.style.borderColor = 'var(--cr-border)'; e.currentTarget.style.color = 'var(--cr-muted)'; }}
        >
            <span style={{ color: 'var(--cr-accent)', fontSize: '9px', fontWeight: 700 }}>{index}</span>
            {host}
        </a>
    );
}

function Sources({ steps }: { steps: TimelineStep[] }) {
    const urls = Array.from(new Set(
        steps.filter(s => s.name === 'web_fetch' || s.name === 'browser')
            .map(s => { try { return JSON.parse(s.args).url as string; } catch { return null; } })
            .filter(Boolean)
    ));
    if (urls.length === 0) return null;
    return (
        <div style={{ marginTop: '18px', paddingTop: '12px', borderTop: '1px solid var(--cr-border)' }}>
            <div style={{ fontFamily: 'var(--cr-font-mono)', fontSize: '9px', color: 'var(--cr-muted-br)', letterSpacing: '0.1em', marginBottom: '10px', textTransform: 'uppercase' }}>Sources</div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px' }}>
                {urls.map((u, i) => <SourceChip key={i} index={i + 1} url={u as string} />)}
            </div>
        </div>
    );
}

interface CycleTimelineProps {
    steps: TimelineStep[];
    agentColor: string;
    /** Live streaming: shows ⋯ on incomplete tools + a working node (no final answer). */
    isActive?: boolean;
    /** Finished: the closing answer node (omit while active). */
    finalAnswerText?: string;
    /** Markdown components for the final answer. */
    mdComponents?: Components;
    /** Live cumulative token count (streaming only). */
    tokenCount?: number;
}

export function CycleTimeline({
    steps, agentColor, isActive = false, finalAnswerText, mdComponents, tokenCount,
}: CycleTimelineProps) {
    const [phraseIndex, setPhraseIndex] = useState(0);

    useEffect(() => {
        if (!isActive) return;
        const id = setInterval(() => setPhraseIndex(i => (i + 1) % THINKING_PHRASES.length), 1500);
        return () => clearInterval(id);
    }, [isActive]);

    const TokenCount = () => typeof tokenCount === 'number'
        ? <span style={{ fontFamily: CR.mono, fontSize: 10, color: CR.muted }}> · {tokenCount.toLocaleString()} tokens</span>
        : null;

    const activeTool = isActive ? [...steps].reverse().find(t => t.result === undefined) : undefined;
    const renderItems = groupSteps(steps);
    const pinnedTodos = findLatestTodoList(steps);

    return (
        <>
        <style>{EXPAND_CSS}</style>
        {pinnedTodos && <TodoChecklist items={pinnedTodos} accentColor={agentColor} />}
        <div style={{ borderLeft: `1px solid ${CR.border}`, marginLeft: 5, paddingLeft: 18, display: 'flex', flexDirection: 'column', gap: 8, paddingTop: 4, paddingBottom: 2 }}>
            {renderItems.map(item => {
                if (item.kind === 'group') {
                    const failed = item.items.some(t => t.result !== undefined && isFailedResult(unwrapResult(t.result)));
                    return (
                        <div key={item.key} style={{ position: 'relative' }}>
                            <span style={{ position: 'absolute', left: -22.5, top: 14, width: 7, height: 7, borderRadius: '50%', background: failed ? 'var(--cr-error)' : 'var(--cr-green)', border: `2px solid ${CR.bgMain}` }} />
                            <GroupRow name={item.name} items={item.items} agentColor={agentColor} isActive={isActive} />
                        </div>
                    );
                }

                if (item.kind === 'tool') {
                    const t = item.step;
                    const done = t.result !== undefined;
                    const failed = done && isFailedResult(unwrapResult(t.result));
                    const dot = failed ? 'var(--cr-error)' : (done ? CR.green : agentColor);
                    return (
                        <div key={item.key} style={{ position: 'relative' }}>
                            <span style={{ position: 'absolute', left: -22.5, top: 14, width: 7, height: 7, borderRadius: '50%', background: dot, border: `2px solid ${CR.bgMain}` }} />
                            <ToolCard t={t} agentColor={agentColor} isActive={isActive} />
                        </div>
                    );
                }

                // thinking — unchanged from before: live compact line, or finished markdown
                // (short inline, long behind a details toggle). Only the dot/spacing moved to
                // line up with the new card rows around it.
                const t = item.step;
                return (
                    <div key={item.key} style={{ position: 'relative', padding: '5px 0' }}>
                        <span style={{ position: 'absolute', left: -22.5, top: 10, width: 7, height: 7, borderRadius: '50%', background: CR.muted, border: `2px solid ${CR.bgMain}` }} />
                        {isActive ? (
                            <span style={{ display: 'inline-flex', alignItems: 'baseline', gap: 7, flexWrap: 'wrap' }}>
                                <span style={{ fontFamily: CR.mono, fontSize: 11.5, fontWeight: 700, color: CR.muted, fontStyle: 'italic' }}>thinking</span>
                                {(() => {
                                    const cleaned = (t.result || '').replace(/<[^>]*>/g, '').trim();
                                    const s = cleaned.slice(0, 120) + (cleaned.length > 120 ? '…' : '');
                                    return s ? <span style={{ fontFamily: CR.mono, fontSize: 11, color: CR.sub, fontStyle: 'italic' }}>{s}</span> : null;
                                })()}
                            </span>
                        ) : (() => {
                            const cleaned = (unwrapResult(t.result) || 'Thinking…').replace(/<[^>]*>/g, '').trim() || 'Thinking…';
                            const previewLimit = 200;
                            const isLong = cleaned.length > previewLimit;
                            const preview = cleaned.slice(0, previewLimit) + (isLong ? '…' : '');

                            if (!isLong) {
                                return (
                                    <div className="agent-md" style={{ fontFamily: CR.sans, fontSize: 12, color: CR.sub, fontStyle: 'italic', lineHeight: 1.6 }}>
                                        <ReactMarkdown remarkPlugins={[remarkGfm]}>{cleaned}</ReactMarkdown>
                                    </div>
                                );
                            }
                            return (
                                <details className="cr-expand">
                                    <summary style={{ listStyle: 'none', cursor: 'pointer', display: 'flex', alignItems: 'baseline', gap: 7 }}>
                                        <span style={{ display: 'inline-flex', alignItems: 'baseline', gap: 7, flexWrap: 'wrap', flex: 1, minWidth: 0 }}>
                                            <span style={{ fontFamily: CR.mono, fontSize: 11.5, fontWeight: 700, color: CR.muted, fontStyle: 'italic' }}>thinking</span>
                                            <span style={{ fontFamily: CR.sans, fontSize: 12, color: CR.sub, fontStyle: 'italic' }}>{preview}</span>
                                        </span>
                                        <Chevron />
                                    </summary>
                                    {/* Flush with the summary above it — same fix as the tool card's
                                        expanded panel, same bug: an indent meant to clear an icon that
                                        this row (deliberately, since dropping the thinking icon) doesn't
                                        have, so it just made the expanded text narrower and shifted right. */}
                                    <div
                                        className="agent-md"
                                        style={{
                                            marginTop: 5, padding: '7px 9px', border: `1px solid ${CR.border}`,
                                            borderRadius: 6, background: CR.bgMain, maxHeight: 320, overflowY: 'auto',
                                            fontFamily: CR.sans, fontSize: 12, color: CR.sub, fontStyle: 'italic', lineHeight: 1.6,
                                        }}
                                    >
                                        <ReactMarkdown remarkPlugins={[remarkGfm]}>
                                            {cleaned.length > 20000 ? cleaned.slice(0, 20000) + '\n\n…' : cleaned}
                                        </ReactMarkdown>
                                    </div>
                                </details>
                            );
                        })()}
                    </div>
                );
            })}

            {isActive ? (
                steps.length > 0 ? (
                    // Working node — reflects the current tool (reading / running / …).
                    <div style={{ position: 'relative' }}>
                        <span style={{ position: 'absolute', left: -22.5, top: 5, width: 7, height: 7, borderRadius: '50%', background: agentColor, border: `2px solid ${CR.bgMain}`, animation: 'crewBlink 1s infinite' }} />
                        <span style={{ fontFamily: CR.mono, fontSize: 10.5, color: CR.muted }}>{phraseForTool(activeTool?.name) + '…'}<TokenCount /></span>
                    </div>
                ) : (
                    // No steps yet — rotate honest reasoning words.
                    <div style={{ position: 'relative' }}>
                        <span style={{ position: 'absolute', left: -22.5, top: 5, width: 7, height: 7, borderRadius: '50%', background: agentColor, border: `2px solid ${CR.bgMain}`, animation: 'crewBlink 1s infinite' }} />
                        <span style={{ display: 'inline-flex', alignItems: 'baseline', gap: 7 }}>
                            <span style={{ fontFamily: CR.mono, fontSize: 11.5, fontWeight: 700, color: agentColor }}>{THINKING_PHRASES[phraseIndex]}</span>
                            <span style={{ color: CR.muted, animation: 'crewBlink 1s infinite', fontSize: 12 }}>⋯</span>
                            <TokenCount />
                        </span>
                    </div>
                )
            ) : finalAnswerText ? (
                // Final answer — the closing node of the thread.
                <div style={{ position: 'relative' }}>
                    <span style={{ position: 'absolute', left: -23.5, top: 6, width: 9, height: 9, borderRadius: '50%', background: agentColor, border: `2px solid ${CR.bgMain}`, boxShadow: `0 0 8px ${agentColor}` }} />
                    <div className="agent-md" style={{ fontFamily: CR.sans, fontSize: 13.5, color: CR.text, lineHeight: 1.7 }}>
                        <ReactMarkdown remarkPlugins={[remarkGfm]} components={mdComponents}>{finalAnswerText}</ReactMarkdown>
                    </div>
                    <CopyButton text={finalAnswerText} />
                </div>
            ) : null}
        </div>
        {!isActive && <Sources steps={steps} />}
        </>
    );
}
