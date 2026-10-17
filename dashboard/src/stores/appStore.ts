import { create } from 'zustand'

interface AppState {
    sidebarCollapsed: boolean
    connectionStatus: 'online' | 'offline'
    toggleSidebar: () => void
    setConnectionStatus: (status: 'online' | 'offline') => void
}

export const useAppStore = create<AppState>((set) => ({
    sidebarCollapsed: false,
    connectionStatus: 'offline',
    toggleSidebar: () =>
        set((state) => ({ sidebarCollapsed: !state.sidebarCollapsed })),
    setConnectionStatus: (status) => set({ connectionStatus: status }),
}))
