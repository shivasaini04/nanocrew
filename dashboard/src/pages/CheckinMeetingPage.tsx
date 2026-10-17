/**
 * CheckinMeetingPage — review an agent's weekly check-in, answer quick-reply
 * questions, and send feedback that gets woven back into the agent's identity.
 *
 * Route: /agents/:agentId/checkin/:checkinId
 */
import { useEffect, useState, useMemo } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { ArrowLeft, Send, CheckCircle } from 'lucide-react';
import { useAgentsStore, type Agent } from '../stores/agentsStore';
import { respondToCheckin } from '../lib/api';

// ─── Types ────────────────────────────────────────────────────────────────────

interface AgentCheckin {
    id: string;
    agent_id: string;
    status: 'pending' | 'delivered' | 'responded';
    report_md?: string;
    user_reply?: string;
    created_at: string;
    responded_at?: string;
}

interface ParsedQuestion {
    text: string;
    options: string[];
}

// ─── Markdown section parser ──────────────────────────────────────────────────

function parseReportSections(md: string): { title: string; body: string }[] {
    const sections: { title: string; body: string }[] = [];
    const lines = md.split('\n');
    let currentTitle = '';
    let currentBody: string[] = [];

    for (const line of lines) {
        if (line.startsWith('## ')) {
            if (currentTitle) sections.push({ title: currentTitle, body: currentBody.join('\n').trim() });
            currentTitle = line.replace('## ', '');
            currentBody = [];
        } else if (line.startsWith('# ') && sections.length === 0 && !currentTitle) {
            // The report header — skip into body
            currentBody.push(line);
        } else {
            currentBody.push(line);
        }
    }
    if (currentTitle) sections.push({ title: currentTitle, body: currentBody.join('\n').trim() });
    return sections;
}

/**
 * Parse "## Questions for You" body into structured questions.
 * Expected format per question:
 *   **Q: <text>**
 *   Options: [Opt A] | [Opt B] | [Opt C]
 */
function parseQuestions(questionsBody: string): ParsedQuestion[] {
    const questions: ParsedQuestion[] = [];
    const blocks = questionsBody.split(/(?=\*\*Q:|^Q\d*:)/m).filter(b => b.trim());

    for (const block of blocks) {
        const qMatch = block.match(/\*?\*?Q[:\d]*:?\*?\*?\s*(.+?)(?:\*\*)?$/m);
        const optMatch = block.match(/Options:\s*(.+)/i);
        if (!qMatch) continue;

        const questionText = qMatch[1].replace(/\*\*/g, '').trim();
        const options = optMatch
            ? optMatch[1].split('|').map(o => o.replace(/[\[\]]/g, '').trim()).filter(Boolean)
            : [];

        questions.push({ text: questionText, options });
    }
    return questions;
}

// ─── Section renderers ────────────────────────────────────────────────────────

function ReportSection({ title, body }: { title: string; body: string }) {
    const lines = body.split('\n').filter(Boolean);
    const bullets = lines.filter(l => l.startsWith('- ') || l.startsWith('• '));
    const rest = lines.filter(l => !l.startsWith('- ') && !l.startsWith('• '));

    const borderColor = {
        'What I Did':        'var(--cr-cyan-line)',
        'Wins':              'var(--cr-green-line)',
        'Observations':      'var(--cr-purple-line)',
        "What's Next":       'var(--cr-amber-line)',
    }[title] ?? 'var(--cr-tint-6)';

    return (
        <div style={{
            borderLeft: `3px solid ${borderColor}`, paddingLeft: '16px', marginBottom: '24px',
        }}>
            <h3 style={{ fontSize: '13px', fontWeight: 700, color: 'var(--text-primary)', marginBottom: '10px', textTransform: 'uppercase', letterSpacing: '0.06em' }}>
                {title}
            </h3>
            {bullets.length > 0 && (
                <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'flex', flexDirection: 'column', gap: '5px' }}>
                    {bullets.map((b, i) => (
                        <li key={i} style={{ display: 'flex', gap: '8px', fontSize: '13px', color: 'var(--text-secondary)', lineHeight: 1.5 }}>
                            <span style={{ color: borderColor, flexShrink: 0 }}>▸</span>
                            <span>{b.replace(/^[-•]\s*/, '')}</span>
                        </li>
                    ))}
                </ul>
            )}
            {rest.map((line, i) => (
                <p key={i} style={{ fontSize: '13px', color: 'var(--text-muted)', lineHeight: 1.5, margin: '4px 0' }}>{line}</p>
            ))}
        </div>
    );
}

function QuestionBlock({
    question, index, selected, onSelect,
}: {
    question: ParsedQuestion; index: number;
    selected: string | null; onSelect: (v: string) => void;
}) {
    return (
        <div style={{
            padding: '14px 16px', borderRadius: 'var(--radius-md)',
            background: 'var(--cr-tint-1)', border: '1px solid var(--border-subtle)',
            marginBottom: '12px',
        }}>
            <div style={{ fontSize: '13px', fontWeight: 500, color: 'var(--text-primary)', marginBottom: '10px' }}>
                <span style={{ color: 'var(--accent-cyan)', marginRight: '6px', fontFamily: 'monospace' }}>Q{index + 1}</span>
                {question.text}
            </div>
            {question.options.length > 0 && (
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px' }}>
                    {question.options.map((opt) => {
                        const isSelected = selected === opt;
                        return (
                            <button
                                key={opt}
                                onClick={() => onSelect(isSelected ? '' : opt)}
                                style={{
                                    padding: '6px 14px', borderRadius: '100px', cursor: 'pointer',
                                    fontSize: '12px', fontWeight: isSelected ? 600 : 400,
                                    background: isSelected ? 'var(--accent-cyan)' : 'var(--cr-tint-4)',
                                    border: isSelected ? '1px solid var(--accent-cyan)' : '1px solid var(--border-default)',
                                    color: isSelected ? 'black' : 'var(--text-secondary)',
                                    transition: 'all 0.15s ease',
                                }}
                                onMouseEnter={e => { if (!isSelected) e.currentTarget.style.borderColor = 'var(--accent-cyan)'; }}
                                onMouseLeave={e => { if (!isSelected) e.currentTarget.style.borderColor = 'var(--border-default)'; }}
                            >
                                {opt}
                            </button>
                        );
                    })}
                </div>
            )}
        </div>
    );
}

// ─── Main page ────────────────────────────────────────────────────────────────

export default function CheckinMeetingPage() {
    const { agentId, checkinId } = useParams<{ agentId: string; checkinId: string }>();
    const navigate = useNavigate();
    const { agents, fetchAgents } = useAgentsStore();

    const [checkin, setCheckin] = useState<AgentCheckin | null>(null);
    const [loadingCheckin, setLoadingCheckin] = useState(true);
    const [agent, setAgent] = useState<Agent | null>(null);
    const [questionAnswers, setQuestionAnswers] = useState<Record<number, string>>({});
    const [freeText, setFreeText] = useState('');
    const [submitting, setSubmitting] = useState(false);
    const [done, setDone] = useState(false);
    const [error, setError] = useState<string | null>(null);

    // Load agent
    useEffect(() => {
        if (!agents.length) fetchAgents();
        const found = agents.find(a => a.id === agentId);
        if (found) setAgent(found);
    }, [agents, agentId]);

    // Load check-in
    useEffect(() => {
        if (!agentId || !checkinId) return;
        setLoadingCheckin(true);
        fetch(`/api/agents/${agentId}/checkins/${checkinId}`)
            .then(r => r.ok ? r.json() : null)
            .then(d => { setCheckin(d); setLoadingCheckin(false); })
            .catch(() => setLoadingCheckin(false));
    }, [agentId, checkinId]);

    // Parse report
    const sections = useMemo(() => checkin?.report_md ? parseReportSections(checkin.report_md) : [], [checkin]);
    const questionsSection = sections.find(s => s.title === 'Questions for You');
    const questions = useMemo(() => questionsSection ? parseQuestions(questionsSection.body) : [], [questionsSection]);
    const otherSections = sections.filter(s => s.title !== 'Questions for You');

    // Auto-populate free text from question answers
    useEffect(() => {
        const answered = Object.entries(questionAnswers)
            .filter(([, v]) => v)
            .map(([i, v]) => `Q${Number(i) + 1}: ${v}`);
        if (answered.length > 0) setFreeText(answered.join('. ') + (freeText ? '. ' + freeText.replace(/^Q\d+:.*\. ?/g, '') : ''));
    }, [questionAnswers]);

    async function handleSubmit() {
        if (!agentId || !checkinId || submitting) return;
        const replyText = freeText.trim();
        if (!replyText) return;

        setSubmitting(true);
        setError(null);
        try {
            await respondToCheckin(agentId, checkinId, replyText);
            setDone(true);
            setTimeout(() => navigate('/agents'), 2500);
        } catch (err: any) {
            setError(err.message);
            setSubmitting(false);
        }
    }

    const isResponded = checkin?.status === 'responded';
    const canSubmit = freeText.trim().length > 0 || Object.values(questionAnswers).some(v => v);

    // ── Loading ──
    if (loadingCheckin) {
        return (
            <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: '100%', color: 'var(--text-muted)', fontSize: '14px' }}>
                Loading check-in…
            </div>
        );
    }

    if (!checkin) {
        return (
            <div className="page-content">
                <div style={{ color: 'var(--accent-red)', padding: '40px', textAlign: 'center' }}>Check-in not found.</div>
            </div>
        );
    }

    const checkinDate = new Date(checkin.created_at).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });

    return (
        <div className="page-content" style={{ maxWidth: '760px', margin: '0 auto' }}>
            {/* Header */}
            <div style={{ marginBottom: '28px' }}>
                <button
                    onClick={() => navigate('/agents')}
                    style={{ display: 'flex', alignItems: 'center', gap: '6px', color: 'var(--text-muted)', fontSize: '12px', background: 'none', border: 'none', cursor: 'pointer', marginBottom: '16px' }}
                >
                    <ArrowLeft size={13} /> Back to Agents
                </button>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                    <div>
                        <h1 style={{ fontSize: 'var(--font-size-xl)', fontWeight: 700, display: 'flex', alignItems: 'center', gap: '10px' }}>
                            📊 Weekly Check-in
                            {agent && <span style={{ fontWeight: 400, color: 'var(--text-muted)' }}>— {agent.name}</span>}
                        </h1>
                        <p style={{ color: 'var(--text-muted)', fontSize: 'var(--font-size-sm)', marginTop: '4px' }}>
                            {checkinDate} · Review your agent's work and give feedback
                        </p>
                    </div>
                    {isResponded && (
                        <div style={{ display: 'flex', alignItems: 'center', gap: '6px', padding: '6px 14px', borderRadius: '100px', background: 'var(--cr-green-low)', border: '1px solid var(--cr-green-line)', color: 'var(--accent-green)', fontSize: '12px' }}>
                            <CheckCircle size={13} /> Responded
                        </div>
                    )}
                </div>
            </div>

            {/* Report card */}
            <div className="glass-card" style={{ padding: '28px', marginBottom: '24px' }}>
                {otherSections.map(s => <ReportSection key={s.title} title={s.title} body={s.body} />)}

                {/* Budget footer line */}
                {checkin.report_md?.match(/Budget used.*:.*\$/i) && (
                    <div style={{ borderTop: '1px solid var(--border-subtle)', paddingTop: '12px', marginTop: '8px', fontSize: '11px', color: 'var(--text-muted)', fontFamily: 'monospace' }}>
                        {checkin.report_md.match(/Budget used.*$/im)?.[0]}
                    </div>
                )}
            </div>

            {/* Questions for You */}
            {questions.length > 0 && !isResponded && (
                <div className="glass-card" style={{ padding: '24px', marginBottom: '24px' }}>
                    <h3 style={{ fontSize: '13px', fontWeight: 700, color: 'var(--text-primary)', marginBottom: '16px', textTransform: 'uppercase', letterSpacing: '0.06em' }}>
                        Questions for You
                    </h3>
                    {questions.map((q, i) => (
                        <QuestionBlock
                            key={i}
                            question={q}
                            index={i}
                            selected={questionAnswers[i] ?? null}
                            onSelect={v => setQuestionAnswers(prev => ({ ...prev, [i]: v }))}
                        />
                    ))}
                </div>
            )}

            {/* Already responded: read-only history */}
            {isResponded && checkin.user_reply && (
                <div className="glass-card" style={{ padding: '24px', marginBottom: '24px' }}>
                    <h3 style={{ fontSize: '13px', fontWeight: 700, color: 'var(--text-primary)', marginBottom: '12px', textTransform: 'uppercase', letterSpacing: '0.06em' }}>
                        Your Feedback — {checkin.responded_at ? new Date(checkin.responded_at).toLocaleDateString() : ''}
                    </h3>
                    <div style={{ fontSize: '13px', color: 'var(--text-secondary)', lineHeight: 1.6, whiteSpace: 'pre-wrap' }}>
                        {checkin.user_reply}
                    </div>
                </div>
            )}

            {/* Feedback + submit — only for pending */}
            {!isResponded && !done && (
                <div className="glass-card" style={{ padding: '24px' }}>
                    <h3 style={{ fontSize: '13px', fontWeight: 700, color: 'var(--text-primary)', marginBottom: '12px', textTransform: 'uppercase', letterSpacing: '0.06em' }}>
                        Your Notes / Feedback
                        <span style={{ fontWeight: 400, color: 'var(--text-muted)', marginLeft: '8px', textTransform: 'none', letterSpacing: 'normal', fontSize: '12px' }}>optional — or type "all good" to approve</span>
                    </h3>
                    <textarea
                        value={freeText}
                        onChange={e => setFreeText(e.target.value)}
                        placeholder="Great work this week. For the fintech question — yes, add those searches. Focus on Series B+ companies…"
                        rows={5}
                        style={{
                            width: '100%', padding: '12px 14px', background: 'var(--cr-tint-3)',
                            border: '1px solid var(--border-default)', borderRadius: 'var(--radius-md)',
                            color: 'var(--text-primary)', fontSize: '13px', fontFamily: 'inherit',
                            lineHeight: 1.6, resize: 'vertical', boxSizing: 'border-box',
                        }}
                        onFocus={e => (e.currentTarget.style.borderColor = 'var(--accent-cyan)')}
                        onBlur={e => (e.currentTarget.style.borderColor = 'var(--border-default)')}
                    />

                    {error && (
                        <div style={{ marginTop: '10px', color: 'var(--accent-red)', fontSize: '12px' }}>{error}</div>
                    )}

                    <div style={{ marginTop: '16px', display: 'flex', justifyContent: 'flex-end' }}>
                        <button
                            onClick={handleSubmit}
                            disabled={!canSubmit || submitting}
                            style={{
                                display: 'flex', alignItems: 'center', gap: '8px',
                                padding: '10px 24px', borderRadius: 'var(--radius-md)',
                                background: canSubmit ? 'var(--accent-cyan)' : 'var(--cr-tint-4)',
                                border: 'none', color: canSubmit ? 'black' : 'var(--text-muted)',
                                fontWeight: 600, fontSize: '13px', cursor: canSubmit ? 'pointer' : 'not-allowed',
                                transition: 'all 0.15s ease',
                            }}
                        >
                            {submitting ? 'Sending…' : <><Send size={14} /> Send Feedback &amp; Resume Agent</>}
                        </button>
                    </div>
                </div>
            )}

            {/* Success state */}
            {done && (
                <div style={{
                    padding: '24px', borderRadius: 'var(--radius-lg)', textAlign: 'center',
                    background: 'var(--cr-green-low)', border: '1px solid var(--cr-green-line)',
                }}>
                    <CheckCircle size={32} color="var(--accent-green)" style={{ marginBottom: '10px' }} />
                    <div style={{ fontWeight: 600, color: 'var(--accent-green)', marginBottom: '4px' }}>Feedback sent.</div>
                    <div style={{ fontSize: '12px', color: 'var(--text-muted)' }}>
                        {agent?.name ?? 'Agent'} has been updated and will incorporate your guidance. Redirecting…
                    </div>
                </div>
            )}
        </div>
    );
}
