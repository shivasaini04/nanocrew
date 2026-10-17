import { create } from 'zustand';
import { getMemory, getSkills } from '../lib/api';

export interface SkillFile {
    filename: string;
    content: string;
}

export interface Skill {
    name: string;
    files: SkillFile[];
}

interface FilesState {
    selectedGroup: string;
    memoryMd: string;
    historyMd: string;
    skills: Skill[];
    loading: boolean;
    error: string | null;

    setSelectedGroup: (folder: string) => void;
    fetchFiles: () => Promise<void>;
}

export const useFilesStore = create<FilesState>((set, get) => ({
    selectedGroup: 'main', // Default to main agent
    memoryMd: '',
    historyMd: '',
    skills: [],
    loading: false,
    error: null,

    setSelectedGroup: (folder: string) => {
        set({ selectedGroup: folder });
        get().fetchFiles();
    },

    fetchFiles: async () => {
        const folder = get().selectedGroup;
        if (!folder) return;

        set({ loading: true, error: null });
        try {
            const [memoryRes, skillsRes] = await Promise.all([
                getMemory(folder),
                getSkills(folder),
            ]);

            set({
                memoryMd: memoryRes.memoryMd || '',
                historyMd: memoryRes.historyMd || '',
                skills: skillsRes || [],
                loading: false,
            });
        } catch (error) {
            set({
                error: error instanceof Error ? error.message : 'Failed to fetch agent workspace files',
                loading: false,
            });
        }
    },
}));
