import { create } from 'zustand';
import { getContainers, type ContainerInfo } from '../lib/api';
import { getSocket } from '../lib/socket';

export interface ContainerStats {
    id: string;
    name: string;
    cpu_percent: string;
    memory_usage: string;
    memory_limit: string;
    memory_percent: string;
}

interface ContainerState {
    containers: ContainerInfo[];
    stats: Record<string, ContainerStats>;
    logs: Record<string, string[]>;
    logStreamsActive: Set<string>;
    loading: boolean;
    error: string | null;

    // Actions
    fetchContainers: () => Promise<void>;
    actionContainer: (id: string, action: 'start' | 'stop' | 'restart') => Promise<void>;
    subscribeLogs: (id: string) => void;
    unsubscribeLogs: (id: string) => void;
    clearLogs: (id: string) => void;
    setupSocketListeners: () => void;
}

export const useContainerStore = create<ContainerState>((set, get) => ({
    containers: [],
    stats: {},
    logs: {},
    logStreamsActive: new Set(),
    loading: false,
    error: null,

    fetchContainers: async () => {
        set({ loading: true, error: null });
        try {
            const res = await getContainers();
            set({ containers: res.containers, loading: false });
        } catch (err: any) {
            set({ error: err.message, loading: false });
        }
    },

    actionContainer: async (id: string, action: 'start' | 'stop' | 'restart') => {
        try {
            const res = await fetch(`/api/containers/${id}/${action}`, { method: 'POST' });
            if (!res.ok) {
                const data = await res.json();
                throw new Error(data.error || 'Action failed');
            }
            // Optimistically update the status if stopped
            if (action === 'stop') {
                set((state) => ({
                    containers: state.containers.map(c =>
                        c.name === id || c.name.slice(1) === id ? { ...c, status: 'Exited' } : c
                    )
                }));
            }
            // Refresh containers after a bit to get real status
            setTimeout(() => get().fetchContainers(), 1000);
        } catch (err: any) {
            set({ error: err.message });
        }
    },

    subscribeLogs: (id: string) => {
        const { logStreamsActive } = get();
        if (logStreamsActive.has(id)) return;

        const socket = getSocket();
        if (socket) {
            socket.emit('container:logs:subscribe', { containerId: id });
            const newActive = new Set(logStreamsActive);
            newActive.add(id);
            set({ logStreamsActive: newActive });
        }
    },

    unsubscribeLogs: (id: string) => {
        const { logStreamsActive } = get();
        if (!logStreamsActive.has(id)) return;

        const socket = getSocket();
        if (socket) {
            socket.emit('container:logs:unsubscribe', { containerId: id });
            const newActive = new Set(logStreamsActive);
            newActive.delete(id);
            set({ logStreamsActive: newActive });
        }
    },

    clearLogs: (id: string) => {
        set((state) => ({
            logs: {
                ...state.logs,
                [id]: []
            }
        }));
    },

    setupSocketListeners: () => {
        const socket = getSocket();
        if (!socket) return;

        // Remove listeners to avoid duplicates if called multiple times
        socket.off('container_stats');
        socket.off('container:log:data');
        socket.off('container:log:error');

        socket.on('container_stats', (statsArray: ContainerStats[]) => {
            set((state) => {
                const updatedStats = { ...state.stats };
                statsArray.forEach(stat => {
                    updatedStats[stat.id] = stat;
                    // Also key by name (stripping leading slash usually present in docker names)
                    if (stat.name) {
                        updatedStats[stat.name.replace(/^\//, '')] = stat;
                    }
                });
                return { stats: updatedStats };
            });
        });

        socket.on('container:log:data', ({ containerId, data }: { containerId: string, data: string }) => {
            set((state) => {
                const currentLogs = state.logs[containerId] || [];
                // Split multi-line data
                const newLines = data.split('\n');

                // Truncate if too many lines to avoid memory leak
                const MAX_LOGS = 1000;
                let nextLogs = [...currentLogs, ...newLines];
                if (nextLogs.length > MAX_LOGS) {
                    nextLogs = nextLogs.slice(nextLogs.length - MAX_LOGS);
                }

                return {
                    logs: {
                        ...state.logs,
                        [containerId]: nextLogs
                    }
                };
            });
        });

        socket.on('container:log:error', ({ containerId, error }: { containerId: string, error: string }) => {
            set({
                error: `Log stream error for ${containerId}: ${error}`
            });
        });
    }
}));
