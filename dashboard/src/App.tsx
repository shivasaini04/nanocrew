import { lazy, Suspense, useEffect, useState } from 'react'
import { socket } from './lib/socket'
import { useLiveBrowsersStore, STALE_AFTER_MS } from './stores/liveBrowsersStore'
import type { ReactNode } from 'react'
import { Routes, Route, Navigate, useLocation } from 'react-router-dom'
import DashboardLayout from './layouts/DashboardLayout'
import LoginPage from './pages/LoginPage'
import SignupPage from './pages/SignupPage'
import ForgotPasswordPage from './pages/ForgotPasswordPage'
import { useAuthStore } from './stores/authStore'
import { maybeHandOffToDesktop } from './lib/desktop-handoff'

declare global {
  interface Window {
    gtag?: (...args: unknown[]) => void
  }
}

const WelcomeOnboarding   = lazy(() => import('./components/WelcomeOnboarding'))
const CommandCenterPage   = lazy(() => import('./pages/CommandCenterPage'))
const ContainersPage      = lazy(() => import('./pages/ContainersPage'))
const SettingsPage        = lazy(() => import('./pages/SettingsPage'))
const CostPage            = lazy(() => import('./pages/CostPage'))
const AgentsPage          = lazy(() => import('./pages/AgentsPage'))
const AgentProfilePage    = lazy(() => import('./pages/AgentProfilePage'))
const CheckinMeetingPage  = lazy(() => import('./pages/CheckinMeetingPage'))
const FilesPage           = lazy(() => import('./pages/FilesPage'))
const ProjectsPage        = lazy(() => import('./pages/ProjectsPage'))
const ProjectDetailPage   = lazy(() => import('./pages/ProjectDetailPage'))
const CrewMapPage         = lazy(() => import('./pages/CrewMapPage'))
const PipelinesPage       = lazy(() => import('./pages/PipelinesPage'))
const NotificationsPage   = lazy(() => import('./pages/NotificationsPage'))
const CheckinsInboxPage   = lazy(() => import('./pages/CheckinsInboxPage'))
const HandoffsInboxPage   = lazy(() => import('./pages/HandoffsInboxPage'))
const ToolsLibraryPage    = lazy(() => import('./pages/ToolsLibraryPage'))
const ApprovalsPage       = lazy(() => import('./pages/ApprovalsPage'))
const RunsPage            = lazy(() => import('./pages/RunsPage'))
const AdminPage           = lazy(() => import('./pages/AdminPage'))
const AdminClientDetailPage = lazy(() => import('./pages/AdminClientDetailPage'))
const LogsPage            = lazy(() => import('./pages/LogsPage'))
const AccountPage         = lazy(() => import('./pages/AccountPage'))
const ArtifactViewPage    = lazy(() => import('./pages/ArtifactViewPage'))

const PageLoader = () => (
  <div style={{
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    height: '100%',
    color: 'var(--cr-muted-br)',
    fontSize: '13px',
  }}>
    Loading…
  </div>
)

// Operator-only route guard — non-admins are bounced to the dashboard home.
function AdminOnly({ children }: { children: ReactNode }) {
  const isAdmin = useAuthStore((s) => s.user?.role === 'admin')
  return isAdmin ? <>{children}</> : <Navigate to="/" replace />
}

/**
 * Shown in the SYSTEM browser after a desktop sign-in has been handed back.
 *
 * The redirect to `nanocrew://` has already fired by the time this renders. It may have
 * silently done nothing — a browser with no handler registered, or a user who declined
 * the "open NanoCrew?" prompt — so this says what happened and offers the link again
 * rather than assuming success.
 */
function DesktopHandoffScreen() {
  return (
    <div style={{
      minHeight: '100vh', display: 'grid', placeItems: 'center',
      background: 'var(--cr-bg)', color: 'var(--cr-text)',
      fontFamily: 'system-ui, sans-serif', padding: 24, textAlign: 'center',
    }}>
      <div style={{ maxWidth: 380 }}>
        <div style={{ fontSize: 30, marginBottom: 14 }}>✓</div>
        <h1 style={{ fontSize: 17, fontWeight: 600, margin: '0 0 10px' }}>You're signed in</h1>
        <p style={{ fontSize: 13.5, lineHeight: 1.6, color: 'var(--cr-muted)', margin: '0 0 18px' }}>
          NanoCrew should have opened on your desktop. You can close this tab.
        </p>
        <p style={{ fontSize: 12, color: 'var(--cr-muted)' }}>
          Nothing happened?{' '}
          <a href={window.location.href} style={{ color: 'var(--cr-accent)' }}>
            try again
          </a>
        </p>
      </div>
    </div>
  )
}

function App() {
  const status = useAuthStore((s) => s.status)
  // Desktop handoff: set once the ticket has been requested, so the dashboard is not
  // rendered in a window the user is about to leave.
  const [isDesktopHandoff, setIsDesktopHandoff] = useState(false)
  const user = useAuthStore((s) => s.user)
  const { pathname } = useLocation()

  useEffect(() => {
    useAuthStore.getState().checkAuth()
    useAuthStore.getState().fetchConfig()
  }, [])

  // GA only sees a full page load once, at initial mount — every navigation after that is
  // client-side routing, invisible to it unless we tell it explicitly (same reason the
  // marketing site has its own usePageTracking hook).
  useEffect(() => {
    window.gtag?.('event', 'page_view', { page_path: pathname })
  }, [pathname])

  // stage 49 phase 4 — which agents have a browser open, tracked app-wide.
  //
  // The frames themselves are nothing new: they have streamed since stage 44. What was
  // missing is that only AgentProfilePage listened, so a live browser was invisible from
  // anywhere else in the app — including the sidebar and the approval card, the two
  // places you would actually notice it. Listening here, once, feeds both.
  //
  // Mounted above the auth gate's return statements would break the rules-of-hooks
  // ordering, so it lives with the other app-level effects and simply receives nothing
  // while logged out (the socket carries only rooms the session can see).
  useEffect(() => {
    const onFrame = (d: { agentId?: string; cycleId?: string; dataUrl: string; url?: string; title?: string }) => {
      if (!d.agentId || !d.dataUrl) return
      useLiveBrowsersStore.getState().noteFrame(d.agentId, {
        dataUrl: d.dataUrl,
        url: d.url ?? '',
        title: d.title ?? '',
        cycleId: d.cycleId,
      })
    }
    const onTakeover = (d: { agentId?: string; cycleId?: string; reason?: string }) => {
      if (!d.agentId || !d.cycleId) return
      useLiveBrowsersStore.getState().noteTakeover(d.agentId, {
        cycleId: d.cycleId,
        reason: d.reason || 'The agent needs a hand.',
      })
    }
    socket.on('chat:frame', onFrame)
    socket.on('chat:takeover', onTakeover)
    // Liveness is inferred from silence rather than from a "closed" event, so something
    // has to notice the silence. Half the stale window keeps the dot honest to ~3s.
    const sweep = setInterval(() => useLiveBrowsersStore.getState().sweep(), STALE_AFTER_MS / 2)
    return () => {
      socket.off('chat:frame', onFrame)
      socket.off('chat:takeover', onTakeover)
      clearInterval(sweep)
    }
  }, [])

  // Fires only when signed in AND the page carries ?desktop=1 AND we are not inside the
  // app — every one of those is checked in maybeHandOffToDesktop.
  useEffect(() => {
    if (status !== 'authed') return
    void maybeHandOffToDesktop().then(started => { if (started) setIsDesktopHandoff(true) })
  }, [status])

  // Resolving the session on boot — avoid flashing the login form for logged-in users.
  if (status === 'loading') return <PageLoader />

  // Not logged in (or session expired) — the whole app is gated behind login + signup.
  if (status === 'anon') return (
    <Routes>
      <Route path="/signup" element={<SignupPage />} />
      <Route path="/forgot-password" element={<ForgotPasswordPage />} />
      <Route path="*" element={<LoginPage />} />
    </Routes>
  )

  // Signed in, in the system browser, at the desktop app's request: hand the session
  // back and tell the user they are done here. Doing this before the dashboard renders
  // matters — landing on a working dashboard in the wrong window is the confusing
  // outcome. See lib/desktop-handoff.ts.
  if (isDesktopHandoff) return <DesktopHandoffScreen />

  // First-run product overview — shown once before a new client enters the dashboard.
  // Operators (admins) skip it; they're not the onboarding audience.
  if (user && user.role !== 'admin' && !user.onboarded_at) return (
    <Suspense fallback={<PageLoader />}>
      <WelcomeOnboarding />
    </Suspense>
  )

  return (
    <Suspense fallback={<PageLoader />}>
      <Routes>
        <Route element={<DashboardLayout />}>

          {/* ── Core routes ─────────────────────────────── */}
          <Route path="/" element={<CommandCenterPage />} />
          <Route path="/files" element={<FilesPage />} />

          {/* ── Projects ────────────────────────────────── */}
          <Route path="/projects" element={<ProjectsPage />} />
          <Route path="/projects/:id" element={<ProjectDetailPage />} />

          {/* ── Crew Map ────────────────────────────────── */}
          <Route path="/crew" element={<CrewMapPage />} />

          {/* ── Pipelines ───────────────────────────────── */}
          <Route path="/pipelines" element={<PipelinesPage />} />

          {/* ── Notifications ───────────────────────────── */}
          <Route path="/notifications" element={<NotificationsPage />} />

          {/* ── Agents ──────────────────────────────────── */}
          <Route path="/agents" element={<AgentsPage />} />
          <Route path="/agents/:id" element={<AgentProfilePage />} />
          <Route path="/agents/:id/manage" element={<AgentProfilePage />} />
          <Route path="/agents/:agentId/checkin/:checkinId" element={<CheckinMeetingPage />} />
          <Route path="/checkins" element={<CheckinsInboxPage />} />
          <Route path="/handoffs" element={<HandoffsInboxPage />} />
          <Route path="/approvals" element={<ApprovalsPage />} />
          <Route path="/runs" element={<RunsPage />} />
          <Route path="/runs/:runId" element={<RunsPage />} />
          <Route path="/artifact" element={<ArtifactViewPage />} />

          {/* Account — every logged-in user */}
          <Route path="/account" element={<AccountPage />} />

          {/* ── Admin (operator only) ───────────────────── */}
          <Route path="/admin" element={<AdminOnly><AdminPage /></AdminOnly>} />
          <Route path="/admin/clients/:id" element={<AdminOnly><AdminClientDetailPage /></AdminOnly>} />

          {/* ── System (infrastructure) ─────────────────── */}
          <Route path="/system/logs" element={<AdminOnly><LogsPage /></AdminOnly>} />
          <Route path="/system/cost" element={<CostPage />} />
          <Route path="/system/containers" element={<ContainersPage />} />
          <Route path="/system/settings" element={<SettingsPage />} />
          <Route path="/system/tools" element={<ToolsLibraryPage />} />

          {/* ── Legacy redirects (old flat nav URLs) ────── */}
          <Route path="/cost" element={<Navigate to="/system/cost" replace />} />
          {/* MCP Servers moved from admin-only System Settings into Account (self-serve). */}
          <Route path="/system/mcp" element={<Navigate to="/account#mcp-servers" replace />} />
          <Route path="/containers" element={<Navigate to="/system/containers" replace />} />
          <Route path="/settings" element={<Navigate to="/system/settings" replace />} />
          {/* Stage 57: the Jobs page became the list of delegated runs. */}
          <Route path="/jobs" element={<Navigate to="/runs" replace />} />
          <Route path="/schedules" element={<Navigate to="/agents" replace />} />
          <Route path="/memory" element={<Navigate to="/agents" replace />} />
          <Route path="/tools" element={<Navigate to="/system/tools" replace />} />
          <Route path="/research" element={<Navigate to="/" replace />} />
          <Route path="/swarm" element={<Navigate to="/" replace />} />

          <Route path="*" element={<Navigate to="/" replace />} />
        </Route>
      </Routes>
    </Suspense>
  )
}

export default App
