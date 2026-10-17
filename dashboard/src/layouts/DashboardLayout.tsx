import { Outlet, Link } from 'react-router-dom'
import Sidebar from '../components/Sidebar'
import KeyboardShortcuts from '../components/KeyboardShortcuts'
import { connectSocket, socket } from '../lib/socket'
import { useEffect, useState } from 'react'
import { Menu } from 'lucide-react'
import PullToRefresh from '../components/PullToRefresh'
import { useAuthStore } from '../stores/authStore'
import { useIsMobile } from '../hooks/useIsMobile'
import { useLocation } from 'react-router-dom'

function ImpersonationBanner() {
    const impersonating = useAuthStore((s) => s.impersonating)
    const user = useAuthStore((s) => s.user)
    const realEmail = useAuthStore((s) => s.realEmail)
    const stop = useAuthStore((s) => s.stopImpersonation)
    if (!impersonating) return null
    return (
        <div style={{
            display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 14,
            padding: '8px 16px', background: 'var(--cr-purple-low)',
            borderBottom: '1px solid var(--cr-purple-line)', flexShrink: 0,
            fontFamily: 'var(--cr-font-sans)', fontSize: 12, color: 'var(--cr-purple)',
        }}>
            <span>👁 Support view — you ({realEmail}) are viewing as <strong style={{ color: 'var(--cr-on-accent)' }}>{user?.email}</strong>. Changes affect their account.</span>
            <button onClick={() => { void stop() }} style={{
                padding: '4px 12px', borderRadius: 6, border: '1px solid var(--cr-purple-line)',
                background: 'var(--cr-purple-line)', color: 'var(--cr-on-accent)', fontSize: 11, fontWeight: 600, cursor: 'pointer',
            }}>Exit support view</button>
        </div>
    )
}

/** Hard-paywall banner: a non-admin user with no active plan can't run agents until they subscribe. */
function PlanBanner() {
    const user = useAuthStore((s) => s.user)
    if (!user || user.role === 'admin' || (typeof user.plan === 'string' && user.plan.trim() !== '')) return null
    return (
        <div style={{
            display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 14,
            padding: '8px 16px', background: 'var(--cr-accent-25)',
            borderBottom: '1px solid var(--cr-accent-60)', flexShrink: 0,
            fontFamily: 'var(--cr-font-sans)', fontSize: 12, color: 'var(--cr-accent-warm)',
        }}>
            <span>⚡ Your crew isn’t active yet — choose a plan to start running your agents.</span>
            <Link to="/account" style={{
                padding: '4px 12px', borderRadius: 6, border: '1px solid var(--cr-accent-60)',
                background: 'var(--cr-accent-40)', color: 'var(--cr-on-accent)', fontSize: 11, fontWeight: 600, textDecoration: 'none',
            }}>Choose a plan</Link>
        </div>
    )
}

export default function DashboardLayout() {
    const isMobile = useIsMobile();
    const [mobileNavOpen, setMobileNavOpen] = useState(false);
    const location = useLocation();

    useEffect(() => {
        connectSocket()
    }, [])

    // Stage 64 phase 1: something needs the owner. When this tab (or the desktop app) isn't
    // in front, a native pop-up — the fallback for when WhatsApp isn't connected or silent.
    useEffect(() => {
        const onPrompt = (n: { title: string; body: string }) => {
            if (!document.hidden || !('Notification' in window) || Notification.permission !== 'granted') return
            try {
                const pop = new Notification(n.title, { body: n.body, tag: 'owner-prompt' })
                pop.onclick = () => { window.focus(); window.location.assign('/checkins') }
            } catch { /* some browsers only allow notifications from a service worker */ }
        }
        socket.on('owner:prompt', onPrompt)
        return () => { socket.off('owner:prompt', onPrompt) }
    }, [])

    // Close the mobile nav drawer on route change (belt-and-suspenders alongside the
    // link-tap handler inside Sidebar) and whenever we leave the mobile breakpoint.
    useEffect(() => { setMobileNavOpen(false) }, [location.pathname])
    useEffect(() => { if (!isMobile) setMobileNavOpen(false) }, [isMobile])


    return (
        <div className="dashboard-layout">
            <Sidebar isMobile={isMobile} mobileOpen={mobileNavOpen} onNavigate={() => setMobileNavOpen(false)} />
            {/* Scrim behind the mobile drawer */}
            {isMobile && mobileNavOpen && (
                <div
                    onClick={() => setMobileNavOpen(false)}
                    style={{ position: 'fixed', inset: 0, background: 'var(--cr-scrim)', zIndex: 900, animation: 'crewFadeIn 0.2s ease-out' }}
                />
            )}
            <div className="main-content" style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0 }}>
                <ImpersonationBanner />
                <PlanBanner />
                {/* Mobile-only bar: just the drawer trigger. Theme, notifications and account
                    (with logout) moved into the sidebar (2026-08-15) — on mobile that's the
                    off-canvas drawer this button opens, so nothing else needs to live up here.
                    Desktop shows no topbar at all now; the sidebar carries the same controls
                    and Outlet content starts right at the top. */}
                {isMobile && (
                    <div style={{
                        height: '48px',
                        borderBottom: '1px solid var(--cr-border)',
                        display: 'flex',
                        alignItems: 'center',
                        padding: '0 12px',
                        flexShrink: 0,
                        background: 'var(--cr-bg-main)',
                    }}>
                        <button
                            onClick={() => setMobileNavOpen(o => !o)}
                            aria-label="Open navigation"
                            style={{
                                display: 'flex', alignItems: 'center', justifyContent: 'center',
                                width: 36, height: 36, borderRadius: 8, flexShrink: 0,
                                background: 'transparent', border: '1px solid var(--cr-border)',
                                color: 'var(--cr-sub)', cursor: 'pointer',
                            }}
                        >
                            <Menu size={18} />
                        </button>
                    </div>
                )}
                <PullToRefresh>
                    <div className="page-content" style={{ flex: 1, overflow: 'auto' }}>
                        <Outlet />
                    </div>
                </PullToRefresh>
            </div>
            <KeyboardShortcuts />
        </div>
    )
}

