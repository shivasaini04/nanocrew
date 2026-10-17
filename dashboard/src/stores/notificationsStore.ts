import { create } from 'zustand';

export type NotificationType =
    | 'cycle_completed'
    | 'cycle_failed'
    | 'pipeline_fired'
    | 'agent_error'
    | 'budget_warning'
    | 'webhook_received'
    | 'subagent_done'
    | 'message_received';

export interface Notification {
    id: string;
    type: NotificationType;
    title: string;
    body: string;
    agent_id: string | null;
    meta: Record<string, unknown> | null;
    read: boolean;
    created_at: string;
}

interface NotificationsState {
    notifications: Notification[];
    unreadCount: number;
    loading: boolean;
    fetchNotifications: () => Promise<void>;
    prependNotification: (n: Notification) => void;
    markRead: (id: string) => Promise<void>;
    markAllRead: () => Promise<void>;
    remove: (id: string) => Promise<void>;
    clearAll: () => Promise<void>;
}

export const useNotificationsStore = create<NotificationsState>((set, get) => ({
    notifications: [],
    unreadCount: 0,
    loading: false,

    fetchNotifications: async () => {
        set({ loading: true });
        try {
            const r = await fetch('/api/notifications?limit=80');
            if (!r.ok) return; // keep current state on error (e.g. transient 401/403)
            const data = await r.json().catch(() => null);
            if (data && Array.isArray(data.notifications)) {
                set({ notifications: data.notifications, unreadCount: data.unreadCount ?? 0 });
            }
        } finally {
            set({ loading: false });
        }
    },

    prependNotification: (n: Notification) => {
        set(s => ({
            notifications: [n, ...s.notifications].slice(0, 200),
            unreadCount: s.unreadCount + (n.read ? 0 : 1),
        }));
    },

    markRead: async (id: string) => {
        await fetch(`/api/notifications/${id}/read`, { method: 'PATCH' });
        set(s => ({
            notifications: s.notifications.map(n => n.id === id ? { ...n, read: true } : n),
            unreadCount: Math.max(0, s.unreadCount - (s.notifications.find(n => n.id === id && !n.read) ? 1 : 0)),
        }));
    },

    markAllRead: async () => {
        await fetch('/api/notifications/read-all', { method: 'POST' });
        set(s => ({
            notifications: s.notifications.map(n => ({ ...n, read: true })),
            unreadCount: 0,
        }));
    },

    remove: async (id: string) => {
        const wasUnread = get().notifications.find(n => n.id === id && !n.read);
        await fetch(`/api/notifications/${id}`, { method: 'DELETE' });
        set(s => ({
            notifications: s.notifications.filter(n => n.id !== id),
            unreadCount: Math.max(0, s.unreadCount - (wasUnread ? 1 : 0)),
        }));
    },

    clearAll: async () => {
        await fetch('/api/notifications', { method: 'DELETE' });
        set({ notifications: [], unreadCount: 0 });
    },
}));
