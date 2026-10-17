import { useNavigate } from 'react-router-dom';
import type { Agent } from '../stores/agentsStore';
import { useAgentsStore } from '../stores/agentsStore';
import { ChevronRight, CheckCircle2 } from 'lucide-react';

interface AgentRoomCardProps {
    agent: Agent;
    onPause: (id: string) => void;
    onResume: (id: string) => void;
}

const TYPE_ICONS: Record<string, string> = {
    market_research: '🔎',
    lead_hunter:     '🔎',
    analytics:       '📊',
    content:         '✍️',
    outreach:        '📧',
    custom:          '🤖',
};

function timeAgo(iso?: string): string {
    if (!iso) return 'Never';
    const diff = Date.now() - new Date(iso).getTime();
    const mins = Math.floor(diff / 60000);
    if (mins < 1) return 'just now';
    if (mins < 60) return `${mins}m ago`;
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return `${hrs}h ago`;
    return `${Math.floor(hrs / 24)}d ago`;
}

export default function AgentRoomCard({ agent, onPause, onResume }: AgentRoomCardProps) {
    const navigate = useNavigate();
    const { activityFeed } = useAgentsStore();
    
    const emoji = agent.emoji || TYPE_ICONS[agent.type] || '🤖';
    const isRunning = agent.status === 'running';

    // Get the latest cycle for this agent for the sub-row
    const latestCycle = activityFeed.find(c => c.agent_id === agent.id);

    return (
        <div 
            onClick={() => navigate(`/agents/${agent.id}`)}
            style={{
                background: 'var(--cr-bg-card)',
                border: '1px solid var(--cr-border)',
                borderRadius: '12px',
                padding: '24px',
                display: 'flex',
                flexDirection: 'column',
                gap: '16px',
                transition: 'all 0.2s cubic-bezier(0.4, 0, 0.2, 1)',
                cursor: 'pointer',
                position: 'relative',
                overflow: 'hidden'
            }} 
            onMouseEnter={e => {
                e.currentTarget.style.background = 'var(--cr-bg-card-hov)';
                e.currentTarget.style.borderColor = 'var(--cr-border-bright)';
            }}
            onMouseLeave={e => {
                e.currentTarget.style.background = 'var(--cr-bg-card)';
                e.currentTarget.style.borderColor = 'var(--cr-border)';
            }}
        >
            {/* Top row: Avatar, Info, and Stats */}
            <div style={{ display: 'flex', gap: '20px', alignItems: 'flex-start' }}>
                
                {/* Avatar with status glow */}
                <div style={{ 
                    width: '64px', 
                    height: '64px', 
                    borderRadius: '16px', 
                    background: 'var(--cr-tint-2)', 
                    border: '1px solid var(--cr-border)',
                    display: 'flex', 
                    alignItems: 'center', 
                    justifyContent: 'center',
                    fontSize: '28px',
                    position: 'relative',
                    flexShrink: 0,
                    boxShadow: isRunning ? '0 0 20px var(--cr-green-low)' : 'none'
                }}>
                    {emoji}
                    <div style={{ 
                        position: 'absolute', 
                        top: -3, 
                        right: -3, 
                        width: '10px', 
                        height: '10px',
                        borderRadius: '50%', 
                        background: isRunning ? 'var(--cr-green)' : 'var(--cr-muted)',
                        border: '2px solid var(--cr-bg-card)',
                        ...(isRunning ? { boxShadow: '0 0 8px var(--cr-green)', animation: 'crewPulse 2s infinite' } : {}) 
                    }} />
                </div>

                {/* Info block */}
                <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '4px' }}>
                        <span style={{
                            fontFamily: 'var(--cr-font-serif)',
                            fontSize: '22px',
                            color: 'var(--cr-cream)',
                            fontWeight: 400
                        }}>{agent.name.replace('[sub] ', '')}</span>
                        {(agent as any).parent_agent_id && (
                            <span style={{
                                fontFamily: 'var(--cr-font-mono)', fontSize: '8px', fontWeight: 700,
                                letterSpacing: '0.08em', textTransform: 'uppercase',
                                padding: '2px 7px', borderRadius: '100px',
                                background: 'var(--cr-purple-low)', border: '1px solid var(--cr-purple-line)',
                                color: 'var(--cr-purple)',
                            }}>sub-agent</span>
                        )}
                        <span style={{ 
                            fontFamily: 'var(--cr-font-mono)', 
                            fontSize: '9px', 
                            color: isRunning ? 'var(--cr-green)' : 'var(--cr-muted)', 
                            fontWeight: 700,
                            letterSpacing: '0.1em',
                            textTransform: 'uppercase',
                            background: isRunning ? 'var(--cr-green-low)' : 'var(--cr-tint-2)',
                            padding: '2px 8px',
                            borderRadius: '100px',
                            border: `1px solid ${isRunning ? 'var(--cr-green-low)' : 'var(--cr-border)'}`
                        }}>{agent.status}</span>
                    </div>
                    <p style={{ 
                        fontFamily: 'var(--cr-font-sans)', 
                        fontSize: '14px', 
                        color: 'var(--cr-sub)', 
                        margin: 0, 
                        lineHeight: 1.5,
                        display: '-webkit-box',
                        WebkitLineClamp: 1,
                        WebkitBoxOrient: 'vertical',
                        overflow: 'hidden'
                    }}>
                        {agent.config.goals}
                    </p>
                </div>

                {/* Stats block */}
                <div style={{ display: 'flex', gap: '32px', alignItems: 'center', flexShrink: 0 }}>
                    <div style={{ textAlign: 'right' }}>
                        <div style={{ fontFamily: 'var(--cr-font-mono)', fontSize: '9px', color: 'var(--cr-muted)', textTransform: 'uppercase', letterSpacing: '0.1em', marginBottom: '4px' }}>Cycles</div>
                        <div style={{ fontFamily: 'var(--cr-font-serif)', fontSize: '20px', color: 'var(--cr-cream)' }}>{agent.cycles || 0}</div>
                    </div>
                    <div style={{ textAlign: 'right' }}>
                        <div style={{ fontFamily: 'var(--cr-font-mono)', fontSize: '9px', color: 'var(--cr-muted)', textTransform: 'uppercase', letterSpacing: '0.1em', marginBottom: '4px' }}>Today</div>
                        <div style={{ fontFamily: 'var(--cr-font-serif)', fontSize: '20px', color: 'var(--cr-cream)' }}>$0.00</div>
                    </div>
                    <div style={{ textAlign: 'right' }}>
                        <div style={{ fontFamily: 'var(--cr-font-mono)', fontSize: '9px', color: 'var(--cr-muted)', textTransform: 'uppercase', letterSpacing: '0.1em', marginBottom: '4px' }}>Next Run</div>
                        <div style={{ fontFamily: 'var(--cr-font-serif)', fontSize: '18px', color: 'var(--cr-cream)' }}>—</div>
                    </div>
                    <ChevronRight size={20} color="var(--cr-muted)" />
                </div>
            </div>

            {/* Sub-row: Latest Activity */}
            {latestCycle && (
                <div style={{ 
                    marginTop: '4px',
                    paddingTop: '16px',
                    borderTop: '1px solid var(--cr-border-sub)',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    gap: '12px'
                }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '10px', minWidth: 0 }}>
                        <CheckCircle2 size={14} color="var(--cr-green)" style={{ flexShrink: 0 }} />
                        <span style={{ fontFamily: 'var(--cr-font-mono)', fontSize: '11px', color: 'var(--cr-muted-br)', flexShrink: 0 }}>{timeAgo(latestCycle.ended_at || latestCycle.started_at)}</span>
                        <span style={{ 
                            fontFamily: 'var(--cr-font-sans)', 
                            fontSize: '13px', 
                            color: 'var(--cr-sub)',
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                            whiteSpace: 'nowrap'
                        }}>
                            {latestCycle.summary || 'Executing sequence...'}
                        </span>
                    </div>

                    {/* File indicator if any (mocking for now as we don't have file refs here yet) */}
                    {latestCycle.summary?.includes('.csv') && (
                        <div style={{ 
                            padding: '3px 10px', 
                            borderRadius: '4px', 
                            background: 'var(--cr-accent-15)',
                            border: '1px solid var(--cr-border)',
                            fontFamily: 'var(--cr-font-mono)',
                            fontSize: '10px',
                            color: 'var(--cr-accent)',
                            flexShrink: 0
                        }}>
                            {latestCycle.summary.split(' ').find(w => w.endsWith('.csv')) || 'data.csv'}
                        </div>
                    )}
                </div>
            )}
        </div>
    );
}
