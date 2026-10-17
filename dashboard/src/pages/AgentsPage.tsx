import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAgentsStore, type Agent } from '../stores/agentsStore';
import { CR, withAlpha } from '../lib/cr';
import HireAgentModal from '../components/HireAgentModal';

/** Format an agent's next scheduled run as a short relative label. Falls back to "manual". */
function formatNextRun(iso?: string | null): string {
    if (!iso) return 'manual';
    const ts = new Date(iso).getTime();
    if (isNaN(ts)) return 'manual';
    const diffMs = ts - Date.now();
    if (diffMs <= 0) return 'due now';
    const mins = Math.round(diffMs / 60000);
    if (mins < 60) return `in ${mins}m`;
    const hours = Math.round(mins / 60);
    if (hours < 24) return `in ${hours}h`;
    const days = Math.round(hours / 24);
    if (days < 7) return `in ${days}d`;
    return new Date(ts).toLocaleDateString([], { month: 'short', day: 'numeric' });
}

export default function AgentsPage() {
    const navigate = useNavigate();
    const { agents, activityFeed, fetchAgents, fetchActivityFeed } = useAgentsStore();
    const [showHire, setShowHire] = useState(false);

    useEffect(() => {
        fetchAgents();
        fetchActivityFeed();
    }, []);

    // Provide default fallbacks to safely map the data into prototype markup
    function mapAgent(ag: Agent) {
        return {
            id: ag.id,
            name: ag.name,
            emoji: ag.emoji || '🤖',
            color: 'var(--cr-accent)', // Mock fallback
            status: ag.status,
            mission: ag.config.goals || 'No mission objective defined.',
            cycles: ag.cycles || 0,
            cyclesToday: ag.cyclesToday ?? 0,
            nextRun: formatNextRun(ag.nextRunAt),
            isExecuting: ag.isExecuting === true,
        };
    }

    return (
        <div style={{ flex: 1, overflowY: 'auto', background: CR.bgMain, display: 'flex', flexDirection: 'column' }}>
            {/* Header */}
            <div style={{
                padding: '44px 48px 32px',
                background: `linear-gradient(180deg, var(--cr-bg-card-hov) 0%, ${CR.bgMain} 100%)`,
                borderBottom: `1px solid ${CR.border}`
            }}>
                <div style={{
                    fontFamily: CR.mono, fontSize: 10, color: CR.muted,
                    letterSpacing: '0.12em', textTransform: 'uppercase', marginBottom: 10
                }}>AGENT ROSTER</div>
                <h1 style={{
                    fontFamily: CR.serif, fontSize: 40, fontWeight: 400,
                    color: CR.cream, margin: '0 0 8px', letterSpacing: '-0.02em'
                }}>Your Crew</h1>
                <p style={{ fontFamily: CR.sans, fontSize: 14, color: CR.sub, margin: 0 }}>
                    {agents.length} specialists · hire, brief, and deploy autonomous AI agents
                </p>
            </div>

            <div style={{ padding: '32px 48px', flex: 1 }}>

                {/* Hire button — first thing on the page, not buried under the roster.
                    Opens the template picker, or the Recruiter for a custom agent. */}
                <div style={{
                    padding: '22px', border: `1px dashed ${CR.border}`, borderRadius: 4,
                    textAlign: 'center', cursor: 'pointer', transition: 'all 0.2s', marginBottom: 24
                }}
                    onClick={() => setShowHire(true)}
                    onMouseEnter={e => { e.currentTarget.style.borderColor = CR.borderBright; e.currentTarget.style.background = CR.accentLow; }}
                    onMouseLeave={e => { e.currentTarget.style.borderColor = CR.border; e.currentTarget.style.background = 'transparent'; }}>
                    <div style={{ fontFamily: CR.serif, fontSize: 18, color: CR.sub, marginBottom: 4 }}>
                        + Hire a new specialist
                    </div>
                    <div style={{ fontFamily: CR.sans, fontSize: 12, color: CR.muted }}>
                        Pick a ready-made specialist, or describe your own
                    </div>
                </div>

                {agents.length === 0 && (
                    <div style={{ fontFamily: CR.mono, color: CR.muted, fontSize: 12, marginBottom: 20 }}>
                        NO ACTIVE AGENTS DEPLOYED
                    </div>
                )}

                {/* Agent cards — expandable. Recruiter excluded: it's the hiring
                    mechanism (reachable via the button above), not a working specialist. */}
                <div style={{ display: 'flex', flexDirection: 'column', gap: 14, marginBottom: 16 }}>
                    {agents.filter(a => a.name !== 'Recruiter').map(rawAgent => {
                        const ag = mapAgent(rawAgent);
                        // Two different questions: isEnabled = the user started it and
                        // the scheduler will fire it; isExecuting = a cycle is running
                        // this second. The card's glow and pulse mean the latter.
                        const isEnabled = ag.status === 'running';
                        const isExecuting = ag.isExecuting;
                        const agCycles = activityFeed.filter(c => c.agent_id === ag.id && c.status === 'completed');
                        
                        return (
                            <div key={ag.id}
                                style={{
                                    background: CR.bgCard, border: `1px solid ${isExecuting ? withAlpha(ag.color, 20) : CR.border}`,
                                    borderLeft: `4px solid ${ag.color}`, borderRadius: 4, overflow: 'hidden',
                                    transition: 'all 0.2s', cursor: 'pointer',
                                    boxShadow: isExecuting ? `0 0 24px ${withAlpha(ag.color, 8)}` : 'none'
                                }}
                                onClick={() => navigate(`/agents/${ag.id}`)}
                                onMouseEnter={e => { e.currentTarget.style.background = CR.bgCardHov; }}
                                onMouseLeave={e => { e.currentTarget.style.background = CR.bgCard; }}>

                                <div style={{ padding: '22px 24px', display: 'flex', alignItems: 'center', gap: 22 }}>
                                    {/* Avatar */}
                                    <div style={{
                                        width: 54, height: 54, borderRadius: 14, flexShrink: 0,
                                        background: `${withAlpha(ag.color, 8)}`, border: `1.5px solid ${withAlpha(ag.color, 15)}`,
                                        display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 24,
                                        position: 'relative'
                                    }}>
                                        {ag.emoji}
                                        {isExecuting && (
                                            <div style={{
                                                position: 'absolute', top: -3, right: -3, width: 11, height: 11,
                                                borderRadius: '50%', background: CR.green, border: `2px solid ${CR.bgCard}`,
                                                animation: 'crewPulse 2s infinite'
                                            }} />
                                        )}
                                    </div>

                                    {/* Identity */}
                                    <div style={{ flex: 1, minWidth: 0 }}>
                                        <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, marginBottom: 6 }}>
                                            <span style={{ fontFamily: CR.serif, fontSize: 20, color: CR.cream, fontWeight: 400 }}>
                                                {ag.name}
                                            </span>
                                            <span style={{
                                                fontFamily: CR.mono, fontSize: 9,
                                                color: isEnabled ? CR.green : CR.muted,
                                                letterSpacing: '0.08em', textTransform: 'uppercase'
                                            }}>{isExecuting ? 'working' : ag.status}</span>
                                        </div>
                                        <p style={{
                                            fontFamily: CR.sans, fontSize: 12, color: CR.sub, margin: 0,
                                            lineHeight: 1.55, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap'
                                        }}>
                                            {ag.mission}
                                        </p>
                                    </div>

                                    {/* Stats */}
                                    <div style={{ display: 'flex', gap: 28, flexShrink: 0 }}>
                                        {[['cycles', ag.cycles], ['today', ag.cyclesToday || '—'], ['next run', ag.nextRun]].map(([k, v]) => (
                                            <div key={k} style={{ textAlign: 'right' }}>
                                                <div style={{
                                                    fontFamily: CR.mono, fontSize: 9, color: CR.muted,
                                                    textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 4
                                                }}>{k}</div>
                                                <div style={{ fontFamily: CR.serif, fontSize: 16, color: CR.cream }}>{v}</div>
                                            </div>
                                        ))}
                                    </div>

                                    {/* Chevron */}
                                    <span style={{ color: CR.muted, fontSize: 18, flexShrink: 0 }}>›</span>
                                </div>

                                {/* Latest cycle preview */}
                                {agCycles[0] && (
                                    <div style={{
                                        padding: '10px 24px 14px', borderTop: `1px solid ${CR.border}`,
                                        display: 'flex', alignItems: 'center', gap: 12
                                    }}>
                                        <span style={{ fontFamily: CR.mono, fontSize: 9, color: CR.green }}>✓</span>
                                        <span style={{ fontFamily: CR.sans, fontSize: 11, color: CR.muted }}>
                                            {new Date(agCycles[0].started_at).toLocaleTimeString()}
                                        </span>
                                        <span style={{
                                            fontFamily: CR.sans, fontSize: 11, color: CR.sub, flex: 1,
                                            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap'
                                        }}>
                                            {agCycles[0].summary || 'Cycle completed'}
                                        </span>
                                    </div>
                                )}
                            </div>
                        );
                    })}
                </div>
            </div>
            {showHire && <HireAgentModal onClose={() => setShowHire(false)} />}
        </div>
    );
}
