import React, { useState, useEffect } from 'react'
import { NavLink, useLocation, useNavigate } from 'react-router-dom'
import { useAgentsStore, type Agent } from '../stores/agentsStore'
import { useAuthStore } from '../stores/authStore'
import { useLiveBrowsersStore, isBrowserLive } from '../stores/liveBrowsersStore'
import { socket } from '../lib/socket'
import NotificationBell from './NotificationBell'
import {
    Search,
    BarChart3,
    PenTool,
    Bot,
    Terminal,
    MessageSquare,
    Files,
    Activity,
    HardDrive,
    Settings,
    ChevronRight,
    Plus,
    FolderKanban,
    Network,
    Workflow,
    Wrench,
    ShieldAlert,
    User,
    Layers,
} from 'lucide-react'

// --- Components ---

/**
 * A collapsible nav group header.
 *
 * Used for anything that is real but not part of the day-one path. The nav had
 * grown to list the system's parts — Files, Crew Map, Pipelines, Containers,
 * Logs — rather than the handful of things a user actually comes here to do,
 * and a new user could not tell which of the six top-level items to click
 * first. Nothing is removed; it is deferred until it means something.
 */
function NavGroup({ label, icon, open, onToggle, isCollapsed, children }: {
    label: string;
    icon: React.ReactNode;
    open: boolean;
    onToggle: () => void;
    isCollapsed: boolean;
    children: React.ReactNode;
}) {
    return (
        <>
            <div
                onClick={onToggle}
                title={isCollapsed ? label : ''}
                style={{
                    display: 'flex', alignItems: 'center', gap: '10px',
                    padding: '6px 20px', cursor: 'pointer',
                    transition: 'all 0.3s cubic-bezier(0.4, 0, 0.2, 1)',
                    borderLeft: '2px solid transparent',
                    overflow: 'hidden', whiteSpace: 'nowrap',
                }}
                onMouseEnter={e => e.currentTarget.style.background = 'var(--cr-tint-1)'}
                onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
            >
                <span style={{ opacity: 0.7, width: '16px', display: 'flex', justifyContent: 'center', color: 'var(--cr-sub)' }}>
                    {icon}
                </span>
                <div style={{
                    display: 'flex', alignItems: 'center', flex: 1,
                    opacity: isCollapsed ? 0 : 1,
                    transform: isCollapsed ? 'translateX(-10px)' : 'translateX(0)',
                    transition: 'all 0.3s cubic-bezier(0.4, 0, 0.2, 1)',
                    pointerEvents: isCollapsed ? 'none' : 'auto',
                }}>
                    <span style={{ fontFamily: 'var(--cr-font-sans)', fontSize: '12px', color: 'var(--cr-sub)', flex: 1 }}>{label}</span>
                    <div style={{
                        color: 'var(--cr-muted)', display: 'flex', alignItems: 'center',
                        transition: 'transform 0.2s', transform: open ? 'rotate(90deg)' : 'none',
                    }}>
                        <ChevronRight size={14} />
                    </div>
                </div>
            </div>
            {open && !isCollapsed && children}
        </>
    )
}

function SectionLabel({ label, isCollapsed }: { label: string; isCollapsed: boolean }) {
    return (
        <div style={{
            height: isCollapsed ? '18px' : '28px',
            padding: isCollapsed ? '8px 20px 0' : '12px 20px 4px',
            fontFamily: 'var(--cr-font-serif)',
            fontSize: '10px',
            color: 'var(--cr-muted-br)',
            letterSpacing: '0.04em',
            userSelect: 'none',
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            opacity: isCollapsed ? 0 : 1,
            pointerEvents: isCollapsed ? 'none' : 'auto',
            transition: 'all 0.3s cubic-bezier(0.4, 0, 0.2, 1)'
        }}>
            <div style={{ transform: isCollapsed ? 'translateX(-10px)' : 'translateX(0)', transition: 'transform 0.3s cubic-bezier(0.4, 0, 0.2, 1)' }}>
                {label}
            </div>
        </div>
    )
}

interface NavItemProps {
    to: string;
    label: string;
    icon: React.ReactNode;
    badge?: number;
    sub?: string;
    onClick?: () => void;
    active: boolean;
    isCollapsed: boolean;
}

function NavItem({ to, label, icon, badge, sub, onClick, active, isCollapsed }: NavItemProps) {
    return (
        <NavLink
            to={to}
            onClick={onClick}
            title={isCollapsed ? label : ""}
            style={{
                display: 'flex',
                alignItems: 'center',
                gap: '10px',
                padding: '6px 20px',
                cursor: 'pointer',
                position: 'relative',
                transition: 'all 0.3s cubic-bezier(0.4, 0, 0.2, 1)',
                background: active ? 'var(--cr-accent-low)' : 'transparent',
                borderLeft: active ? '2px solid var(--cr-accent)' : '2px solid transparent',
                textDecoration: 'none',
                overflow: 'hidden',
                whiteSpace: 'nowrap'
            }}
            onMouseEnter={e => { if (!active) e.currentTarget.style.background = 'var(--cr-tint-1)'; }}
            onMouseLeave={e => { if (!active) e.currentTarget.style.background = 'transparent'; }}
        >
            <span style={{
                fontSize: '14px',
                lineHeight: 1,
                flexShrink: 0,
                opacity: active ? 1 : 0.7,
                width: '16px',
                display: 'flex',
                justifyContent: 'center'
            }}>{icon}</span>

            <div style={{
                display: 'flex',
                flex: 1,
                alignItems: 'center',
                opacity: isCollapsed ? 0 : 1,
                transform: isCollapsed ? 'translateX(-10px)' : 'translateX(0)',
                transition: 'all 0.3s cubic-bezier(0.4, 0, 0.2, 1)',
                pointerEvents: isCollapsed ? 'none' : 'auto',
                overflow: 'hidden'
            }}>
                <span style={{
                    fontFamily: 'var(--cr-font-sans)',
                    fontSize: '12px',
                    fontWeight: active ? 500 : 400,
                    color: active ? 'var(--cr-cream)' : 'var(--cr-sub)',
                    flex: 1,
                    whiteSpace: 'nowrap',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis'
                }}>
                    {label}
                </span>
                {sub && <span style={{ fontFamily: 'var(--cr-font-mono)', fontSize: '9px', color: 'var(--cr-muted)' }}>{sub}</span>}
                {badge && badge > 0 ? (
                    <div style={{
                        width: '16px',
                        height: '16px',
                        borderRadius: '50%',
                        background: 'var(--cr-accent)',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        fontFamily: 'var(--cr-font-mono)',
                        fontSize: '9px',
                        color: 'var(--cr-on-accent)',
                        flexShrink: 0,
                        marginLeft: '8px'
                    }}>{badge}</div>
                ) : null}
            </div>

            <div style={{
                position: 'absolute',
                top: '6px',
                left: '36px',
                width: '6px',
                height: '6px',
                borderRadius: '50%',
                background: 'var(--cr-accent)',
                boxShadow: '0 0 5px var(--cr-accent)',
                opacity: (isCollapsed && badge && badge > 0) ? 1 : 0,
                transition: 'opacity 0.3s'
            }} />
        </NavLink>
    )
}

function AgentItem({ agent, active, isCollapsed, unreadCount }: { agent: Agent; active: boolean; isCollapsed: boolean; unreadCount?: number }) {
    const isRunning = agent.status === 'running'
    // stage 49 phase 4. The green dot above means `status === 'running'` — the agent is
    // working at all. This is the narrower, more useful fact: it has a browser open that
    // you can watch RIGHT NOW. Without it the live view was reachable only by already
    // being on the agent's chat tab when it happened, which is how an operator came to
    // approve a click on a page nobody had seen.
    const browserLive = useLiveBrowsersStore(s => isBrowserLive(s.byAgent, agent.id))
    // Waiting on a person outranks merely browsing: this is the one that needs
    // somebody to act, and it should be findable without opening the agent first.
    const browserWaiting = useLiveBrowsersStore(s => !!s.waiting[agent.id])
    const getIcon = () => {
        // If it's a specific emoji, use it, otherwise use professional icons
        const emojiIcons: Record<string, string> = {
            '🔬': '🔬',
            '📊': '📊',
            '✍️': '✍️'
        }

        if (agent.emoji && !emojiIcons[agent.emoji]) return agent.emoji

        const name = agent.name.toLowerCase()
        if (name.includes('research')) return <Search size={12} strokeWidth={2.5} />
        if (name.includes('analyst') || name.includes('beta')) return <BarChart3 size={12} strokeWidth={2.5} />
        if (name.includes('writer') || name.includes('gamma')) return <PenTool size={12} strokeWidth={2.5} />

        const typeIcons: Record<string, any> = {
            market_research: <Search size={12} strokeWidth={2.5} />,
            lead_hunter: <Search size={12} strokeWidth={2.5} />,
            analytics: <BarChart3 size={12} strokeWidth={2.5} />,
            content: <PenTool size={12} strokeWidth={2.5} />,
            custom: <Bot size={12} strokeWidth={2.5} />
        }

        return typeIcons[agent.type] || <Bot size={12} strokeWidth={2.5} />
    }

    const icon = getIcon()

    return (
        <NavLink
            to={`/agents/${agent.id}`}
            title={isCollapsed ? agent.name : ""}
            style={{
                display: 'flex',
                alignItems: 'center',
                gap: '10px',
                padding: '6px 20px',
                cursor: 'pointer',
                transition: 'all 0.3s cubic-bezier(0.4, 0, 0.2, 1)',
                background: active ? 'var(--cr-tint-2)' : 'transparent',
                borderLeft: active ? '2px solid var(--cr-accent)' : '2px solid transparent',
                textDecoration: 'none',
                overflow: 'hidden',
                whiteSpace: 'nowrap',
                position: 'relative',
            }}
            onMouseEnter={e => { if (!active) e.currentTarget.style.background = 'var(--cr-tint-1)'; }}
            onMouseLeave={e => { if (!active) e.currentTarget.style.background = 'transparent'; }}
        >
            {/* Emoji avatar */}
            <div style={{
                width: '22px',
                height: '22px',
                borderRadius: '6px',
                flexShrink: 0,
                background: 'var(--cr-tint-3)',
                border: '1px solid var(--cr-border)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                fontSize: '12px',
                position: 'relative'
            }}>
                <div style={{ color: active ? 'var(--cr-accent)' : 'var(--cr-sub)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                    {icon}
                </div>
            </div>

            <div style={{
                display: 'flex',
                flex: 1,
                alignItems: 'center',
                opacity: isCollapsed ? 0 : 1,
                transform: isCollapsed ? 'translateX(-10px)' : 'translateX(0)',
                transition: 'all 0.3s cubic-bezier(0.4, 0, 0.2, 1)',
                pointerEvents: isCollapsed ? 'none' : 'auto',
                overflow: 'hidden',
                gap: '8px'
            }}>
                <span style={{
                    fontFamily: 'var(--cr-font-sans)',
                    fontSize: '12px',
                    fontWeight: active ? 500 : 400,
                    color: active ? 'var(--cr-cream)' : 'var(--cr-sub)',
                    flex: 1,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap'
                }}>
                    {agent.name}
                </span>
                {unreadCount && unreadCount > 0 ? (
                    <div style={{
                        minWidth: '16px',
                        height: '16px',
                        borderRadius: '8px',
                        background: 'var(--cr-accent)',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        fontFamily: 'var(--cr-font-mono)',
                        fontSize: '9px',
                        fontWeight: 700,
                        color: 'var(--cr-on-accent)',
                        padding: '0 5px',
                        flexShrink: 0,
                    }}>{unreadCount}</div>
                ) : null}
                {(browserLive || browserWaiting) && (
                    <span
                        title={browserWaiting ? 'Waiting for you to take over' : 'Browser open — click to watch'}
                        aria-label={browserWaiting ? 'Waiting for you' : 'Browser open'}
                        style={{
                            fontSize: '11px',
                            lineHeight: 1,
                            flexShrink: 0,
                            filter: 'saturate(0.9)',
                            animation: 'crewPulse 2s infinite',
                        }}
                    >{browserWaiting ? '✋' : '🖥'}</span>
                )}
                {isRunning && (
                    <div style={{
                        width: '6px',
                        height: '6px',
                        borderRadius: '50%',
                        background: 'var(--cr-green)',
                        flexShrink: 0,
                        boxShadow: '0 0 8px var(--cr-green)',
                        animation: 'crewPulse 2s infinite'
                    }} />
                )}
            </div>

            <div style={{
                position: 'absolute',
                top: '6px',
                left: '27px',
                width: '6px',
                height: '6px',
                borderRadius: '50%',
                background: 'var(--cr-accent)',
                boxShadow: '0 0 5px var(--cr-accent)',
                opacity: (isCollapsed && unreadCount && unreadCount > 0) ? 1 : 0,
                transition: 'opacity 0.3s'
            }} />
        </NavLink>
    )
}

// --- Main Sidebar Component ---

export default function Sidebar({ isMobile = false, mobileOpen = false, onNavigate }: {
    isMobile?: boolean;
    /** Drawer visibility on mobile (ignored on desktop). */
    mobileOpen?: boolean;
    /** Called when the user taps a nav link on mobile so the parent can close the drawer. */
    onNavigate?: () => void;
} = {}) {
    const location = useLocation()
    const navigate = useNavigate()
    const { agents, fetchAgents } = useAgentsStore()
    const user = useAuthStore(s => s.user)
    const isAdmin = useAuthStore(s => s.user?.role === 'admin')
    const [systemOpen, setSystemOpen] = useState(false)
    const [advancedOpen, setAdvancedOpen] = useState(false)
    const [isCollapsed, setIsCollapsed] = useState(false)
    const [pendingApprovals, setPendingApprovals] = useState(0)
    const [unreadCounts, setUnreadCounts] = useState<Record<string, number>>({})

    // On mobile the sidebar is a full-width off-canvas drawer, never the 68px rail —
    // force it expanded so all labels show (the collapse toggle is desktop-only).
    useEffect(() => { if (isMobile) setIsCollapsed(false) }, [isMobile])

    useEffect(() => {
        const onChatMessage = (data: { id: string; chatJid: string; text: string; timestamp: string; sender: string }) => {
            if (data.sender === 'User' || data.sender === 'user') return;

            const matchedAgent = agents.find(a => a.whatsapp_jid === data.chatJid);
            if (!matchedAgent) return;

            if (location.pathname === `/agents/${matchedAgent.id}`) return;

            setUnreadCounts(prev => ({
                ...prev,
                [matchedAgent.id]: (prev[matchedAgent.id] || 0) + 1
            }));
        };

        socket.on('chat:message', onChatMessage);
        return () => {
            socket.off('chat:message', onChatMessage);
        };
    }, [agents, location.pathname]);

    useEffect(() => {
        const match = location.pathname.match(/\/agents\/([^/]+)/);
        if (match) {
            const agentId = match[1];
            setUnreadCounts(prev => {
                if (!prev[agentId]) return prev;
                const next = { ...prev };
                delete next[agentId];
                return next;
            });
        }
    }, [location.pathname]);

    function refreshApprovalBadge() {
        fetch('/api/computer-use/escalations')
            .then(r => r.ok ? r.json() : { escalations: [] })
            .then((d: any) => setPendingApprovals((d.escalations ?? []).length))
            .catch(() => { })
    }

    useEffect(() => {
        fetchAgents()
        refreshApprovalBadge()
        window.addEventListener('escalation:refresh', refreshApprovalBadge)
        return () => {
            window.removeEventListener('escalation:refresh', refreshApprovalBadge)
        }
    }, [])

    useEffect(() => {
        if (location.pathname.startsWith('/system')) setSystemOpen(true)
    }, [location.pathname])

    const isActive = (path: string) =>
        path === '/' ? location.pathname === '/' : location.pathname.startsWith(path)

    const isAgentActive = (id: string) => location.pathname.startsWith(`/agents/${id}`)

    return (
        <aside
            // On mobile, close the drawer when a nav link (rendered as <a>) is tapped.
            onClick={isMobile ? (e) => { if ((e.target as HTMLElement).closest('a')) onNavigate?.() } : undefined}
            style={{
            width: isCollapsed ? '68px' : '240px',
            height: '100vh',
            flexShrink: 0,
            background: 'var(--cr-bg-sidebar)',
            borderRight: '1px solid var(--cr-border)',
            display: 'flex',
            flexDirection: 'column',
            overflow: 'hidden',
            zIndex: isMobile ? 1000 : 10,
            ...(isMobile ? {
                position: 'fixed' as const, top: 0, left: 0,
                transform: mobileOpen ? 'translateX(0)' : 'translateX(-100%)',
                transition: 'transform 0.3s cubic-bezier(0.4, 0, 0.2, 1)',
                boxShadow: mobileOpen ? '0 0 40px var(--cr-shade-3)' : 'none',
            } : {
                transition: 'width 0.3s cubic-bezier(0.4, 0, 0.2, 1)',
            }),
        }}>

            {/* Logo & Toggle */}
            <div style={{
                padding: '18px 20px 14px',
                display: 'flex',
                alignItems: 'center',
                gap: '12px',
                minHeight: '62px',
                borderBottom: '1px solid var(--cr-border)',
                position: 'relative',
                whiteSpace: 'nowrap',
                overflow: 'hidden'
            }}>
                <img
                    src="/nanocrew-logo.png"
                    alt="nanocrew"
                    style={{
                        width: '28px',
                        height: '28px',
                        objectFit: 'contain',
                        flexShrink: 0,
                        cursor: 'pointer',
                        zIndex: 2
                    }}
                    onClick={() => { if (isMobile) onNavigate?.(); else setIsCollapsed(!isCollapsed) }}
                />

                <div style={{
                    display: 'flex',
                    alignItems: 'center',
                    flex: 1,
                    opacity: isCollapsed ? 0 : 1,
                    transform: isCollapsed ? 'translateX(-10px)' : 'translateX(0)',
                    transition: 'all 0.3s cubic-bezier(0.4, 0, 0.2, 1)',
                    pointerEvents: isCollapsed ? 'none' : 'auto',
                }}>
                    <span style={{
                        fontFamily: 'var(--cr-font-serif)',
                        fontSize: '17px',
                        color: 'var(--cr-cream)',
                        letterSpacing: '-0.01em',
                        flex: 1
                    }}>nanocrew</span>
                    {/* Collapse-to-rail toggle — desktop only. On mobile the sidebar is a
                        full-width off-canvas drawer with a single open/close control (the
                        topbar hamburger); collapsing it to an icon rail here left no way
                        back to the full drawer since this button doesn't know about the
                        mobile open/close state. */}
                    {/* Notifications live beside the collapse control (2026-09-06).
                        They were in a footer strip with the theme toggle, which put the
                        one thing that changes on its own — a count you want to notice —
                        at the far bottom of the column, below every nav item. Top-right
                        is where a bell is looked for. */}
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                        <NotificationBell placement="sidebar" />
                    {!isMobile && (
                        <button
                            onClick={() => setIsCollapsed(true)}
                            style={{
                                color: 'var(--cr-muted)',
                                fontSize: '10px',
                                background: 'var(--cr-tint-4)',
                                padding: '4px',
                                borderRadius: '4px',
                                display: 'flex',
                                alignItems: 'center',
                                justifyContent: 'center',
                                cursor: 'pointer',
                                border: '1px solid transparent'
                            }}
                            onMouseEnter={e => e.currentTarget.style.border = '1px solid var(--cr-border)'}
                            onMouseLeave={e => e.currentTarget.style.border = '1px solid transparent'}
                        >
                            «
                        </button>
                    )}
                    </div>
                </div>
            </div>

            {/* Nav */}
            <nav style={{ flex: 1, overflowY: 'auto', paddingBottom: '8px' }}>

                {/* COMMAND — only what a user needs on day one.
                    Approvals stays top-level even when empty: it is part of the core
                    loop (your crew asks, you answer), and a nav item that disappears
                    when idle can never be found or learned. Crew Map, Files and
                    Pipelines moved into Advanced below — they are ways of looking at
                    things you already have, not places you go to get work done. */}
                <SectionLabel label="Command" isCollapsed={isCollapsed} />
                <NavItem to="/" label="Command Center" icon={<Terminal size={16} />} active={isActive('/')} isCollapsed={isCollapsed} />
                {/* Projects only earns nav space once there is more than one agent to
                    coordinate. Single-agent users never reach for it, and showing it
                    on day one adds a concept with nothing behind it. */}
                {agents.length > 1 && (
                    <NavItem to="/projects" label="Projects" icon={<FolderKanban size={16} />} active={isActive('/projects')} isCollapsed={isCollapsed} />
                )}
                <NavItem to="/approvals" label="Approvals" icon={<ShieldAlert size={16} />} active={isActive('/approvals')} badge={pendingApprovals || undefined} isCollapsed={isCollapsed} />
                {/* Stage 57: where an agent's parallel workers can be watched. Always shown,
                    for the same reason Approvals is — hidden when idle, it is never found. */}
                <NavItem to="/runs" label="Runs" icon={<Layers size={16} />} active={location.pathname.startsWith('/runs')} isCollapsed={isCollapsed} />

                {/* YOUR CREW — Recruiter excluded: it's the hiring mechanism, not a
                    working specialist, and it's already reachable one click below via
                    "Hire New Agent" → "Describe your own". Listing it here too was two
                    doors to the same room. */}
                <SectionLabel label="Your Crew" isCollapsed={isCollapsed} />
                {agents.filter(ag => ag.name !== 'Recruiter').map(ag => (
                    <AgentItem key={ag.id} agent={ag} active={isAgentActive(ag.id)} isCollapsed={isCollapsed} unreadCount={unreadCounts[ag.id]} />
                ))}

                <div onClick={() => navigate('/agents')}
                    title={isCollapsed ? "Hire New Agent" : ""}
                    style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: '10px',
                        padding: '9px 20px',
                        cursor: 'pointer',
                        transition: 'all 0.3s cubic-bezier(0.4, 0, 0.2, 1)',
                        borderLeft: isActive('/agents') && !agents.some(a => isAgentActive(a.id)) ? '2px solid var(--cr-accent)' : '2px solid transparent',
                        background: isActive('/agents') && !agents.some(a => isAgentActive(a.id)) ? 'var(--cr-tint-2)' : 'transparent',
                        overflow: 'hidden',
                        whiteSpace: 'nowrap',
                        marginTop: '4px'
                    }}
                    onMouseEnter={e => { if (!isActive('/agents')) e.currentTarget.style.background = 'var(--cr-tint-1)'; }}
                    onMouseLeave={e => { if (!isActive('/agents')) e.currentTarget.style.background = 'transparent'; }}
                >
                    <div style={{
                        width: '22px',
                        height: '22px',
                        borderRadius: '6px',
                        flexShrink: 0,
                        border: '1px dashed var(--cr-muted)',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        color: 'var(--cr-muted)'
                    }}>
                        <Plus size={12} />
                    </div>
                    <div style={{
                        display: 'flex',
                        alignItems: 'center',
                        flex: 1,
                        opacity: isCollapsed ? 0 : 1,
                        transform: isCollapsed ? 'translateX(-10px)' : 'translateX(0)',
                        transition: 'all 0.3s cubic-bezier(0.4, 0, 0.2, 1)',
                        pointerEvents: isCollapsed ? 'none' : 'auto',
                    }}>
                        <span style={{
                            fontFamily: 'var(--cr-font-sans)',
                            fontSize: '12px',
                            color: 'var(--cr-sub)'
                        }}>
                            Hire New Agent
                        </span>
                    </div>
                </div>


                {/* ADVANCED — real features, deferred rather than removed.
                    Everything here is either a different view of something you already
                    have (Crew Map is a view of your crew, Files a view of a workspace)
                    or a power feature that is meaningless until you have work to chain
                    (Pipelines). Collapsed by default; one click away forever. */}
                <SectionLabel label="More" isCollapsed={isCollapsed} />
                <NavGroup
                    label="Advanced"
                    icon={<Workflow size={16} />}
                    open={advancedOpen}
                    isCollapsed={isCollapsed}
                    onToggle={() => {
                        // From the 68px rail there is nowhere to render children, so
                        // expand the sidebar first rather than toggling invisibly.
                        if (isCollapsed) { setIsCollapsed(false); setAdvancedOpen(true) }
                        else setAdvancedOpen(!advancedOpen)
                    }}
                >
                    <NavItem to="/crew" label="Crew Map" icon={<Network size={14} />} active={isActive('/crew')} isCollapsed={isCollapsed} />
                    <NavItem to="/files" label="Files" icon={<Files size={14} />} active={isActive('/files')} isCollapsed={isCollapsed} />
                    <NavItem to="/pipelines" label="Pipelines" icon={<Workflow size={14} />} active={isActive('/pipelines')} isCollapsed={isCollapsed} />
                    {agents.length <= 1 && (
                        <NavItem to="/projects" label="Projects" icon={<FolderKanban size={14} />} active={isActive('/projects')} isCollapsed={isCollapsed} />
                    )}
                </NavGroup>

                {/* ADMIN (operator only) */}
                {isAdmin && (
                    <>
                        <SectionLabel label="Admin" isCollapsed={isCollapsed} />
                        <NavItem to="/admin" label="Admin Panel" icon={<ShieldAlert size={16} />} active={location.pathname.startsWith('/admin')} isCollapsed={isCollapsed} />
                    </>
                )}

                {/* SYSTEM (operator only) */}
                {isAdmin && (<>
                <SectionLabel label="System" isCollapsed={isCollapsed} />
                <NavGroup
                    label="Infrastructure"
                    icon={<HardDrive size={16} />}
                    open={systemOpen}
                    isCollapsed={isCollapsed}
                    onToggle={() => {
                        if (isCollapsed) { setIsCollapsed(false); setSystemOpen(true) }
                        else setSystemOpen(!systemOpen)
                    }}
                >
                    <NavItem to="/system/cost" label="Cost & Usage" icon={<Activity size={14} />} active={location.pathname === '/system/cost'} isCollapsed={isCollapsed} />
                    <NavItem to="/system/logs" label="Logs" icon={<Terminal size={14} />} active={location.pathname === '/system/logs'} isCollapsed={isCollapsed} />
                    <NavItem to="/system/containers" label="Containers" icon={<HardDrive size={14} />} active={location.pathname === '/system/containers'} isCollapsed={isCollapsed} />
                    <NavItem to="/system/tools" label="Tools Library" icon={<Wrench size={14} />} active={location.pathname === '/system/tools'} isCollapsed={isCollapsed} />
                    <NavItem to="/system/settings" label="Settings" icon={<Settings size={14} />} active={location.pathname === '/system/settings'} isCollapsed={isCollapsed} />
                </NavGroup>
                </>)}
            </nav>

            {/* The theme + notifications strip that used to sit here is gone (2026-09-06).
                The bell moved to the top beside the collapse control, where a bell is
                looked for; the theme toggle moved onto the Account page, since appearance
                is a setting you change once rather than a control you reach for. What is
                left at the bottom is the one thing worth pinning: which account you are in. */}

            {/* Account — pinned at the bottom for every user (above the footer). Shows the
                logged-in email instead of a generic "Account" label so the account you're in
                is always visible, not just discoverable by clicking through. Logging out lives
                on the Account page itself now, not up here. */}
            <div style={{ padding: '6px 8px', borderTop: isCollapsed ? '1px solid var(--cr-border)' : 'none' }}>
                <NavItem
                    to="/account"
                    label={user?.email || 'Account'}
                    icon={<User size={16} />}
                    active={location.pathname === '/account'}
                    isCollapsed={isCollapsed}
                />
            </div>

            {/* Footer */}
            <div style={{
                padding: '16px 20px 24px',
                borderTop: '1px solid var(--cr-border)',
                display: 'flex',
                alignItems: 'center',
                position: 'relative',
                whiteSpace: 'nowrap',
                overflow: 'hidden',
                minHeight: '65px'
            }}>
                {isCollapsed && (
                    <div style={{
                        width: '100%',
                        display: 'flex',
                        justifyContent: 'flex-start',
                        paddingLeft: '4px'
                    }}>
                        <span style={{ fontSize: '12px', color: 'var(--cr-muted)', cursor: 'pointer', padding: '4px' }} onClick={() => setIsCollapsed(false)}>»</span>
                    </div>
                )}

                <div style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    flex: 1,
                    opacity: isCollapsed ? 0 : 1,
                    transform: isCollapsed ? 'translateX(-10px)' : 'translateX(0)',
                    transition: 'all 0.3s cubic-bezier(0.4, 0, 0.2, 1)',
                    pointerEvents: isCollapsed ? 'none' : 'auto',
                    position: isCollapsed ? 'absolute' : 'relative',
                    width: '100%',
                    left: 20
                }}>
                    <span style={{ fontFamily: 'var(--cr-font-mono)', fontSize: '9px', color: 'var(--cr-muted)' }}>v0.1.0</span>
                </div>
            </div>
        </aside>
    )
}
