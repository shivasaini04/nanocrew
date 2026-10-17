import { io, Socket } from 'socket.io-client'
import { useAppStore } from '../stores/appStore'
import { useContainerStore } from '../stores/containerStore'
import { useAgentsStore } from '../stores/agentsStore'
import { useNotificationsStore } from '../stores/notificationsStore'

export const socket = io(window.location.origin, {
    path: '/socket.io',
    transports: ['websocket'],
    autoConnect: false,
    withCredentials: true,
})

export function connectSocket(): Socket {
    if (socket.connected) return socket

    socket.connect()

    socket.on('connect', () => {
        useAppStore.getState().setConnectionStatus('online')
        useContainerStore.getState().setupSocketListeners()
    })

    socket.on('disconnect', () => {
        useAppStore.getState().setConnectionStatus('offline')
    })

    // ── Agent events ──────────────────────────────────────────────────────────

    // Agent started / paused / stopped (reason may be 'budget_exceeded')
    socket.on('agent:status_changed', ({ agentId, status, reason }: { agentId: string; status: string; reason?: string }) => {
        useAgentsStore.getState().patchAgent(agentId, { status: status as any, _pauseReason: reason } as any)
    })

    // Agent created → refetch full list so sidebar gets the new entry
    socket.on('agent:created', () => {
        useAgentsStore.getState().fetchAgents()
    })

    // Agent deleted → remove from list
    socket.on('agent:deleted', ({ agentId }: { agentId: string }) => {
        useAgentsStore.getState().removeAgent(agentId)
    })

    // Agent config / name changed
    socket.on('agent:updated', () => {
        useAgentsStore.getState().fetchAgents()
    })

    // Cycle completed → push to top of activity feed
    socket.on('agent:cycle_completed', (cycle: any) => {
        useAgentsStore.getState().prependFeedItem(cycle)
    })

    // New check-in created — refresh badge count
    socket.on('agent:checkin_created', () => {
        useAgentsStore.getState().fetchPendingCheckins()
    })

    // Check-in responded — remove from pending list
    socket.on('agent:checkin_responded', () => {
        useAgentsStore.getState().fetchPendingCheckins()
    })

    // New handoff created — refresh agents so handoff badges update
    socket.on('agent:handoff_created', ({ toAgentId }: { fromAgentId: string; toAgentId: string; handoffId: string; type: string }) => {
        useAgentsStore.getState().patchAgent(toAgentId, { _hasNewHandoff: true } as any)
        // Sidebar badge refreshes via its own useEffect on next render — dispatch a custom event
        window.dispatchEvent(new Event('handoff:refresh'))
    })

    // ── Computer-use escalations ──────────────────────────────────────────────

    // New escalation created — update sidebar badge
    socket.on('computer_use:escalation_created', () => {
        window.dispatchEvent(new Event('escalation:refresh'))
    })

    // Escalation resolved (approve/deny from another tab) — refresh list
    socket.on('computer_use:escalation_resolved', () => {
        window.dispatchEvent(new Event('escalation:refresh'))
    })

    // ── Notifications ─────────────────────────────────────────────────────────
    socket.on('notification:new', (n: any) => {
        useNotificationsStore.getState().prependNotification(n)
    })

    return socket
}

export function getSocket(): Socket | null {
    return socket
}
