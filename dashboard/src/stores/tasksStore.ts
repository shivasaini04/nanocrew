import { create } from 'zustand';
import { getTasks, createTask, updateTask, deleteTask, type ScheduledTask } from '../lib/api';

interface TasksState {
    tasks: ScheduledTask[];
    loading: boolean;
    error: string | null;

    // Actions
    fetchTasks: () => Promise<void>;
    addTask: (task: Partial<ScheduledTask>) => Promise<void>;
    toggleTaskStatus: (id: string, currentStatus: string) => Promise<void>;
    removeTask: (id: string) => Promise<void>;
}

export const useTasksStore = create<TasksState>((set) => ({
    tasks: [],
    loading: false,
    error: null,

    fetchTasks: async () => {
        set({ loading: true, error: null });
        try {
            const data = await getTasks();
            set({ tasks: data, loading: false });
        } catch (err: any) {
            set({ error: err.message, loading: false });
        }
    },

    addTask: async (task: Partial<ScheduledTask>) => {
        set({ loading: true, error: null });
        try {
            const newTask = await createTask(task);
            set((state) => ({
                tasks: [newTask, ...state.tasks],
                loading: false
            }));
        } catch (err: any) {
            set({ error: err.message, loading: false });
        }
    },

    toggleTaskStatus: async (id: string, currentStatus: string) => {
        const newStatus = currentStatus === 'active' ? 'paused' : 'active';
        try {
            await updateTask(id, { status: newStatus as any });
            set((state) => ({
                tasks: state.tasks.map((t) =>
                    t.id === id ? { ...t, status: newStatus as any } : t
                )
            }));
        } catch (err: any) {
            console.error('Failed to toggle task status:', err);
        }
    },

    removeTask: async (id: string) => {
        try {
            await deleteTask(id);
            set((state) => ({
                tasks: state.tasks.filter((t) => t.id !== id)
            }));
        } catch (err: any) {
            console.error('Failed to delete task:', err);
        }
    }
}));
