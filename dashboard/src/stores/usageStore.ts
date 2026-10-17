import { create } from 'zustand';
import { getUsageSummary, getSessionUsage } from '../lib/api';

export interface UsageSummary {
    model: string;
    total_prompt: number;
    total_completion: number;
    grand_total: number;
}

export interface SessionUsage {
    session_id: string;
    chat_jid: string;
    model: string;
    total_prompt: number;
    total_completion: number;
    grand_total: number;
    last_activity: string;
}

interface UsageState {
    summary: UsageSummary[];
    sessions: SessionUsage[];
    loading: boolean;
    error: string | null;
    fetchUsageData: () => Promise<void>;
}

export const useUsageStore = create<UsageState>((set) => ({
    summary: [],
    sessions: [],
    loading: false,
    error: null,

    fetchUsageData: async () => {
        set({ loading: true, error: null });
        try {
            const [summaryData, sessionsData] = await Promise.all([
                getUsageSummary(),
                getSessionUsage(),
            ]);

            set({
                summary: summaryData as UsageSummary[],
                sessions: sessionsData as SessionUsage[],
                loading: false,
            });
        } catch (error) {
            set({
                error: error instanceof Error ? error.message : 'Failed to fetch usage data',
                loading: false,
            });
        }
    },
}));
