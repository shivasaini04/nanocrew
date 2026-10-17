import { create } from 'zustand';
import { getSettings, updateSettings } from '../lib/api';

interface SettingsState {
    settings: Record<string, string>;
    isLoading: boolean;
    isSaving: boolean;
    error: string | null;
    successMessage: string | null;
    fetchSettings: () => Promise<void>;
    saveSettings: (updates: Record<string, string>) => Promise<void>;
    clearFeedback: () => void;
}

export const useSettingsStore = create<SettingsState>((set) => ({
    settings: {},
    isLoading: false,
    isSaving: false,
    error: null,
    successMessage: null,

    fetchSettings: async () => {
        set({ isLoading: true, error: null });
        try {
            const data = await getSettings() as Record<string, string>;
            set({ settings: data, isLoading: false });
        } catch (err: any) {
            set({ error: err.message || 'Failed to fetch settings', isLoading: false });
        }
    },

    saveSettings: async (updates) => {
        set({ isSaving: true, error: null, successMessage: null });
        try {
            await updateSettings(updates);

            // Optimistically update the local cache
            set((state) => ({
                settings: { ...state.settings, ...updates },
                isSaving: false,
                successMessage: 'Settings securely updated.'
            }));

            setTimeout(() => {
                set({ successMessage: null });
            }, 3000);

        } catch (err: any) {
            set({ error: err.message || 'Failed to save settings', isSaving: false });
        }
    },

    clearFeedback: () => set({ error: null, successMessage: null })
}));
