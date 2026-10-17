import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { getStatus, getContainers, getTasks, type SystemStatus, type ContainersResponse, type ScheduledTask } from '../lib/api'
import { connectSocket } from '../lib/socket'
import { useAgentsStore } from '../stores/agentsStore'
import { useAuthStore } from '../stores/authStore'
import HireAgentModal from '../components/HireAgentModal'
import { useIsMobile } from '../hooks/useIsMobile'

function timeAgo(iso?: string): string {
    if (!iso) return 'Never'
    const diff = Date.now() - new Date(iso).getTime()
    const mins = Math.floor(diff / 60000)
    if (mins < 1) return 'just now'
    if (mins < 60) return `${mins}m ago`
    const hrs = Math.floor(mins / 60)
    if (hrs < 24) return `${hrs}h ago`
    return `${Math.floor(hrs / 24)}d ago`
}

export default function CommandCenterPage() {
    const navigate = useNavigate()
    const isMobile = useIsMobile()
    const { agents, activityFeed, fetchAgents, fetchActivityFeed } = useAgentsStore()

    const [status, setStatus] = useState<SystemStatus | null>(null)
    const [containers, setContainers] = useState<ContainersResponse | null>(null)
    const [tasks, setTasks] = useState<ScheduledTask[]>([])
    const [loading, setLoading] = useState(true)
    const [showHire, setShowHire] = useState(false)

    useEffect(() => {
        load()
        // Handoff from the welcome onboarding's final CTA — open the hire picker so a brand
        // new user flows straight from the product overview into hiring their first agent.
        if (sessionStorage.getItem('nc_open_hire') === '1') {
            sessionStorage.removeItem('nc_open_hire')
            setShowHire(true)
        }
    }, [])

    async function load() {
        try {
            // Containers are operator-only (admin); clients get a 403, so don't fetch it for them.
            const isAdmin = useAuthStore.getState().user?.role === 'admin'
            const [s, t] = await Promise.all([getStatus(), getTasks()])
            setStatus(s)
            setTasks(t)
            if (isAdmin) {
                try { setContainers(await getContainers()) } catch { /* ignore */ }
            }
        } catch { /* API unavailable */ }
        finally { setLoading(false) }

        fetchAgents()
        fetchActivityFeed()
    }

    const runningAgents = agents.filter(a => a.status === 'running')
    const totalCycles = agents.reduce((s, a) => s + (a.cycles || 0), 0) // fallback for legacy data
    const costToday = status?.costToday ?? 0.00 // Assuming backend might have this, otherwise from agents
    const totalSpent = agents.reduce((s, a) => s + (a.costTotal || 0), 0)

    const recentCycles = activityFeed.slice(0, 5)

    return (
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>

            {/* Hero Section */}
            <div className="hero-gradient" style={{ padding: 'var(--cr-page-padding-v) var(--cr-page-padding-h) 36px' }}>
                <div style={{
                    fontFamily: 'var(--cr-font-mono)',
                    fontSize: '10px',
                    color: 'var(--cr-muted)',
                    letterSpacing: '0.12em',
                    textTransform: 'uppercase',
                    marginBottom: '10px'
                }}>
                    {new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })} · {status?.uptimeHuman ?? 'connecting…'} uptime
                </div>
                <h1 style={{
                    fontFamily: 'var(--cr-font-serif)',
                    fontSize: isMobile ? '30px' : '44px',
                    fontWeight: 400,
                    color: 'var(--cr-cream)',
                    margin: '0 0 10px',
                    letterSpacing: '-0.02em',
                    lineHeight: 1.15
                }}>
                    {agents.length === 0
                        ? <>Hire your <span style={{ color: 'var(--cr-accent-warm)' }}>first specialist</span></>
                        : runningAgents.length > 0
                            ? <>{runningAgents.map(a => a.name).join(' & ')} {runningAgents.length === 1 ? 'is' : 'are'} <span style={{ color: 'var(--cr-accent-warm)' }}>working now</span></>
                            : <>Your crew is <span style={{ color: 'var(--cr-sub)' }}>standing by</span></>}
                </h1>
                <p style={{
                    fontFamily: 'var(--cr-font-sans)',
                    fontSize: '14px',
                    color: 'var(--cr-sub)',
                    maxWidth: '540px',
                    lineHeight: 1.65,
                    margin: 0
                }}>
                    {agents.length === 0
                        ? 'A specialist is an AI teammate you put to work on one kind of job. Pick one to get started — you can change what it does at any time.'
                        : runningAgents.length > 0
                            ? `${runningAgents.map(a => a.name).join(' and ')} ${runningAgents.length === 1 ? 'is' : 'are'} running right now. ${agents.length - runningAgents.length} agents on standby.`
                            : 'Nobody is working right now. Open a specialist to give it something to do, or wait for its next scheduled run.'}
                </p>

                {/* The primary action, always present.
                    It used to exist only as a modal opened by a sessionStorage handoff from
                    the welcome onboarding — so there was no way to hire from this page at
                    all, and the one path there was died with the browser tab. New users
                    landed here, were told to "trigger a cycle" on agents they did not have,
                    and had to be told out loud to go and recruit someone. */}
                <button
                    onClick={() => setShowHire(true)}
                    style={{
                        marginTop: 20,
                        padding: agents.length === 0 ? '12px 26px' : '9px 18px',
                        borderRadius: 8,
                        border: agents.length === 0 ? 'none' : '1px solid var(--cr-border)',
                        background: agents.length === 0 ? 'var(--cr-accent)' : 'transparent',
                        color: agents.length === 0 ? 'var(--cr-on-accent)' : 'var(--cr-sub)',
                        fontFamily: 'var(--cr-font-sans)',
                        fontSize: agents.length === 0 ? 14 : 12.5,
                        fontWeight: 600,
                        cursor: 'pointer',
                        transition: 'all 0.15s',
                    }}
                    onMouseEnter={e => {
                        if (agents.length > 0) {
                            e.currentTarget.style.borderColor = 'var(--cr-border-bright)';
                            e.currentTarget.style.color = 'var(--cr-cream)';
                        }
                    }}
                    onMouseLeave={e => {
                        if (agents.length > 0) {
                            e.currentTarget.style.borderColor = 'var(--cr-border)';
                            e.currentTarget.style.color = 'var(--cr-sub)';
                        }
                    }}
                >
                    {agents.length === 0 ? 'Hire your first specialist' : '+ Hire a specialist'}
                </button>
            </div>

            <div style={{ padding: '36px var(--cr-page-padding-h) var(--cr-page-padding-bottom)', display: 'flex', flexDirection: 'column', gap: '36px' }}>

                {/* Hire picker — opened on first run via the welcome onboarding handoff,
                    or any time the user chooses to add an agent. */}
                {showHire && <HireAgentModal onClose={() => setShowHire(false)} />}

                {/* Before the first hire there is nothing real to show: the stats read all
                    zeros, and the crew, activity and "happening now" panels are empty
                    shells. Rendering them buries the single thing the user should do
                    behind a wall of blanks, so the first screen is the hero and its
                    button, and nothing else. */}
                {agents.length === 0 ? null : <>

                {/* Stats row */}
                <div style={{
                    display: 'grid',
                    gridTemplateColumns: isMobile ? 'repeat(2, 1fr)' : 'repeat(4, 1fr)',
                    gap: '2px'
                }}>
                    {[
                        { label: 'Agents', value: agents.length, note: `${runningAgents.length} running` },
                        { label: 'Total Cycles', value: totalCycles || '-', note: 'all time' },
                        { label: 'Spent Today', value: `$${costToday.toFixed(2)}`, note: 'across all agents' },
                        { label: 'Total Spent', value: `$${totalSpent.toFixed(2)}`, note: 'all time' },
                    ].map(({ label, value, note }) => (
                        <div key={label} style={{
                            padding: isMobile ? '14px 16px' : '20px 24px',
                            background: 'var(--cr-bg-surf)',
                            border: '1px solid var(--cr-border)',
                            borderRadius: '2px',
                            minWidth: 0
                        }}>
                            <div style={{
                                fontFamily: 'var(--cr-font-mono)',
                                fontSize: '9px',
                                color: 'var(--cr-muted-br)',
                                letterSpacing: '0.1em',
                                textTransform: 'uppercase',
                                marginBottom: '8px'
                            }}>{label}</div>
                            <div style={{
                                fontFamily: 'var(--cr-font-serif)',
                                fontSize: '28px',
                                color: 'var(--cr-cream)',
                                marginBottom: '4px'
                            }}>{value}</div>
                            <div style={{
                                fontFamily: 'var(--cr-font-mono)',
                                fontSize: '10px',
                                color: 'var(--cr-muted)'
                            }}>{note}</div>
                        </div>
                    ))}
                </div>

                {/* Happening Now (Running Agents) */}
                {runningAgents.length > 0 && (
                    <div>
                        <div style={{
                            fontFamily: 'var(--cr-font-serif)',
                            fontSize: '18px',
                            color: 'var(--cr-sub)',
                            marginBottom: '14px'
                        }}>Happening now</div>
                        <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
                            {runningAgents.map(ag => (
                                <div key={ag.id}
                                    onClick={() => navigate(`/agents/${ag.id}`)}
                                    style={{
                                        background: 'var(--cr-bg-card)',
                                        border: '1px solid var(--cr-border)',
                                        borderLeft: `3px solid var(--cr-accent)`,
                                        borderRadius: '4px',
                                        padding: '18px 22px',
                                        cursor: 'pointer',
                                        transition: 'all 0.2s',
                                        display: 'flex',
                                        alignItems: 'center',
                                        gap: '18px'
                                    }}
                                    className="premium-card"
                                >
                                    <div style={{
                                        width: '44px',
                                        height: '44px',
                                        borderRadius: '12px',
                                        flexShrink: 0,
                                        background: 'var(--cr-accent-25)',
                                        border: '1px solid var(--cr-accent-40)',
                                        display: 'flex',
                                        alignItems: 'center',
                                        justifyContent: 'center',
                                        fontSize: '20px'
                                    }}>{ag.emoji || '🔍'}</div>
                                    <div style={{ flex: 1, minWidth: 0 }}>
                                        <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '5px' }}>
                                            <span style={{ fontFamily: 'var(--cr-font-serif)', fontSize: '18px', color: 'var(--cr-cream)' }}>{ag.name}</span>
                                            <div style={{ display: 'flex', alignItems: 'center', gap: '5px' }}>
                                                <div style={{
                                                    width: '5px',
                                                    height: '5px',
                                                    borderRadius: '50%',
                                                    background: 'var(--cr-green)',
                                                    animation: 'crewPulse 2s infinite'
                                                }} />
                                                <span style={{ fontFamily: 'var(--cr-font-mono)', fontSize: '9px', color: 'var(--cr-green)', letterSpacing: '0.06em' }}>RUNNING</span>
                                            </div>
                                        </div>
                                        <p style={{
                                            fontFamily: 'var(--cr-font-sans)',
                                            fontSize: '12px',
                                            color: 'var(--cr-sub)',
                                            margin: 0,
                                            lineHeight: 1.5,
                                            overflow: 'hidden',
                                            textOverflow: 'ellipsis',
                                            whiteSpace: 'nowrap'
                                        }}>
                                            {/* Guarded, because an agent with no mission
                                                set has `goals` undefined and `.slice` on
                                                it throws — taking the WHOLE Command
                                                Center down with an error boundary, not
                                                just this one card. Every other read of
                                                this field in the app already guards
                                                (AgentsPage, AgentProfilePage); this was
                                                the one that did not. Found live
                                                2026-09-04. */}
                                            Target: {ag.config.goals
                                                ? `${ag.config.goals.slice(0, 90)}…`
                                                : 'No mission objective defined.'}
                                        </p>
                                    </div>
                                    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: '4px', flexShrink: 0 }}>
                                        <div style={{ fontFamily: 'var(--cr-font-mono)', fontSize: '10px', color: 'var(--cr-sub)' }}>last: {timeAgo(ag.last_active)}</div>
                                        <div style={{ fontFamily: 'var(--cr-font-mono)', fontSize: '10px', color: 'var(--cr-muted)' }}>v{ag.identity_version}</div>
                                    </div>
                                    <span style={{ color: 'var(--cr-muted)', fontSize: '16px' }}>›</span>
                                </div>
                            ))}
                        </div>
                    </div>
                )}

                {/* Your Crew Grid */}
                <div>
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '14px' }}>
                        <div style={{ fontFamily: 'var(--cr-font-serif)', fontSize: '18px', color: 'var(--cr-sub)' }}>Your crew</div>
                        <button onClick={() => navigate('/agents')}
                            style={{
                                fontFamily: 'var(--cr-font-sans)',
                                fontSize: '12px',
                                color: 'var(--cr-accent)',
                                background: 'none',
                                border: 'none',
                                cursor: 'pointer',
                                padding: 0
                            }}>
                            Manage →
                        </button>
                    </div>
                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: '12px' }}>
                        {agents.map(ag => {
                            const isRunning = ag.status === 'running'
                            return (
                                <div key={ag.id}
                                    onClick={() => navigate(`/agents/${ag.id}`)}
                                    style={{
                                        background: 'var(--cr-bg-card)',
                                        border: `1px solid ${isRunning ? 'var(--cr-green-line)' : 'var(--cr-border)'}`,
                                        borderRadius: '10px',
                                        padding: '18px 20px',
                                        cursor: 'pointer',
                                        transition: 'all 0.2s',
                                        boxShadow: isRunning ? '0 0 20px var(--cr-green-low)' : 'none'
                                    }}
                                    className="premium-card"
                                >
                                    <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: '12px' }}>
                                        <div style={{
                                            width: '40px',
                                            height: '40px',
                                            borderRadius: '11px',
                                            background: 'var(--cr-tint-2)',
                                            border: '1px solid var(--cr-border)',
                                            display: 'flex',
                                            alignItems: 'center',
                                            justifyContent: 'center',
                                            fontSize: '18px'
                                        }}>{ag.emoji || '🤖'}</div>
                                        <div style={{
                                            display: 'flex',
                                            alignItems: 'center',
                                            gap: '5px',
                                            padding: '3px 8px',
                                            borderRadius: '100px',
                                            background: isRunning ? 'var(--cr-green-low)' : 'var(--cr-tint-2)',
                                            border: `1px solid ${isRunning ? 'var(--cr-green-line)' : 'var(--cr-border)'}`
                                        }}>
                                            <div style={{
                                                width: '4px',
                                                height: '4px',
                                                borderRadius: '50%',
                                                background: isRunning ? 'var(--cr-green)' : 'var(--cr-muted)',
                                                ...(isRunning ? { animation: 'crewPulse 2s infinite' } : {})
                                            }} />
                                            <span style={{
                                                fontFamily: 'var(--cr-font-mono)',
                                                fontSize: '9px',
                                                color: isRunning ? 'var(--cr-green)' : 'var(--cr-muted)',
                                                letterSpacing: '0.06em',
                                                textTransform: 'uppercase'
                                            }}>{ag.status}</span>
                                        </div>
                                    </div>
                                    <div style={{ fontFamily: 'var(--cr-font-serif)', fontSize: '16px', color: 'var(--cr-cream)', marginBottom: '5px' }}>{ag.name}</div>
                                    <div style={{
                                        fontFamily: 'var(--cr-font-sans)',
                                        fontSize: '11px',
                                        color: 'var(--cr-sub)',
                                        lineHeight: 1.5,
                                        overflow: 'hidden',
                                        display: '-webkit-box',
                                        WebkitLineClamp: 2,
                                        WebkitBoxOrient: 'vertical'
                                    }}>{ag.config.goals}</div>
                                    <div style={{ marginTop: '12px', display: 'flex', justifyContent: 'space-between' }}>
                                        <span style={{ fontFamily: 'var(--cr-font-mono)', fontSize: '10px', color: 'var(--cr-muted)' }}>v{ag.identity_version} identity</span>
                                        <span style={{ fontFamily: 'var(--cr-font-mono)', fontSize: '10px', color: 'var(--cr-accent-warm)' }}>{timeAgo(ag.last_active)}</span>
                                    </div>
                                </div>
                            )
                        })}
                    </div>
                </div>

                {/* Recent Feed */}
                <div>
                    <div style={{ fontFamily: 'var(--cr-font-serif)', fontSize: '18px', color: 'var(--cr-sub)', marginBottom: '14px' }}>Recent work</div>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
                        {recentCycles.map(c => {
                            const ag = agents.find(a => a.id === c.agent_id)
                            if (!ag) return null
                            return (
                                <div key={c.id}
                                    onClick={() => navigate(`/agents/${c.agent_id}`)}
                                    style={{
                                        display: 'flex',
                                        gap: '16px',
                                        alignItems: 'flex-start',
                                        padding: '14px 20px',
                                        background: 'var(--cr-bg-surf)',
                                        border: '1px solid var(--cr-border)',
                                        borderLeft: `2px solid var(--cr-border)`,
                                        transition: 'background 0.15s',
                                        cursor: 'pointer'
                                    }}
                                    onMouseEnter={e => e.currentTarget.style.background = 'var(--cr-bg-card)'}
                                    onMouseLeave={e => e.currentTarget.style.background = 'var(--cr-bg-surf)'}
                                >
                                    <div style={{ fontSize: '15px', marginTop: '1px', flexShrink: 0 }}>{ag.emoji || '🔍'}</div>
                                    <div style={{ flex: 1, minWidth: 0 }}>
                                        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '4px' }}>
                                            <span style={{ fontFamily: 'var(--cr-font-sans)', fontWeight: 500, fontSize: '12px', color: 'var(--cr-cream)' }}>{ag.name}</span>
                                            <span style={{ fontFamily: 'var(--cr-font-mono)', fontSize: '10px', color: 'var(--cr-green)' }}>✓</span>
                                            <span style={{ fontFamily: 'var(--cr-font-mono)', fontSize: '10px', color: 'var(--cr-muted)' }}>{timeAgo(c.ended_at || c.started_at)}</span>
                                        </div>
                                        <p style={{
                                            fontFamily: 'var(--cr-font-sans)',
                                            fontSize: '12px',
                                            color: 'var(--cr-sub)',
                                            margin: 0,
                                            lineHeight: 1.5
                                        }}>{c.summary || c.cycle_type}</p>
                                    </div>
                                    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: '3px', flexShrink: 0 }}>
                                        <span style={{ fontFamily: 'var(--cr-font-mono)', fontSize: '10px', color: 'var(--cr-accent-warm)' }}>${c.cost.toFixed(2)}</span>
                                        <span style={{ fontFamily: 'var(--cr-font-mono)', fontSize: '10px', color: 'var(--cr-muted)' }}>{c.tasks_done} tasks</span>
                                    </div>
                                </div>
                            )
                        })}
                    </div>
                </div>

                </>}

            </div>
        </div>
    )
}
