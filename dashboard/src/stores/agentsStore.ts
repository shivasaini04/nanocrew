import { create } from 'zustand';

// ─── Types (mirroring backend types.ts) ──────────────────────────────────────

export type AgentType = 'lead_hunter' | 'outreach' | 'market_research' | 'analytics' | 'followup' | 'content' | 'custom';
export type AgentStatus = 'idle' | 'running' | 'paused' | 'error';
export type CycleType = 'lead_search' | 'send_outreach' | 'followup' | 'checkin' | 'self_improve' | 'custom';
export type CycleStatus = 'running' | 'completed' | 'failed';

export interface AgentPersonality {
    voice?: string;
    expertise?: string[];
    style?: string;
    color?: string;
}

export interface AgentConfig {
    schedule: { type: CycleType; interval: string; enabled: boolean; project_id?: string }[];
    triggerMode?: 'scheduled' | 'on_demand' | 'event_driven';
    budget: { daily: number; monthly: number; onExhaust: 'pause' | 'alert' };
    tools: string[];
    icp?: string;
    goals: string;
    escalationRules: string[];
    notifications?: Record<string, boolean>;
    personality?: AgentPersonality;
    model?: string;
    customSystemPrompt?: { mode: 'augment' | 'replace'; content: string };
    customWorkspaceDirs?: Array<{ name: string; description?: string }>;
    references?: Array<{ filename: string; type: string; size: number; addedAt: string }>;
    pins?: string[];
    webhookToken?: string;
}

export interface Agent {
    id: string;
    name: string;
    type: AgentType;
    emoji?: string;
    status: AgentStatus;
    workspace: string;
    config: AgentConfig;
    identity_version: number;
    created_at: string;
    last_active?: string;
    whatsapp_jid?: string;
    cycles?: number;
    cyclesToday?: number;
    nextRunAt?: string | null;
    /**
     * Executing a cycle at this very moment. Use this for live "working now"
     * affordances (pulse, glow) — `status: 'running'` means the agent is
     * *started*, and stays true between scheduled cycles.
     */
    isExecuting?: boolean;
    costTotal?: number;
    _pauseReason?: string; // transient — set by socket, not persisted
}

/** A PATCH body: top-level fields replace, `config` keys are merged into the saved config. */
export type AgentUpdate = Partial<Omit<Agent, 'config'>> & { config?: Partial<AgentConfig> & Record<string, unknown> };

export interface AgentCycle {
    id: string;
    agent_id: string;
    cycle_type: CycleType;
    status: CycleStatus;
    started_at: string;
    ended_at?: string;
    summary?: string;
    cost: number;
    tasks_done: number;
}

export interface AgentCheckin {
    id: string;
    agent_id: string;
    status: 'pending' | 'delivered' | 'responded';
    report_md?: string;
    user_reply?: string;
    created_at: string;
    responded_at?: string;
    action_type?: string;
    action_payload?: string;
}

export interface ProposedTool {
    id: string;
    name: string;
    label: string;
    description: string;
    category: string;
    rationale: string;
    requiredCredentials: string[];
    parameters: { type: 'object'; properties: Record<string, { type: string; description: string }>; required?: string[] };
}

export interface TrackerStage {
    key: string;
    label: string;
    color: string;
}

export interface TrackerField {
    key: string;
    label: string;
    type: 'text' | 'url' | 'number' | 'date';
}

export interface TrackerSchema {
    name: string;
    namePlural: string;
    stages: TrackerStage[];
    fields: TrackerField[];
}

export interface CreateAgentInput {
    name: string;
    type: AgentType;
    emoji?: string;
    config: AgentConfig;
    trackerSchema?: TrackerSchema;
    proposedTools?: ProposedTool[];
    referenceFiles?: File[];
}

export interface ChatMessage {
    id: string;
    role: 'user' | 'assistant';
    content: string;
    tool_traces?: string;
    created_at: string;
    images?: string[];   // base64 data URLs attached to a user message (shown in the bubble)
    source?: string;     // originating channel (e.g. 'whatsapp'); undefined = native dashboard
}
 
export interface FileEntry {
    id: string;
    context: string;
    contextId: string;
    path: string;
    filename: string;
    extension: string;
    sizeBytes: number;
    modifiedAt: string;
    createdAt: string;
}

// ─── Store ────────────────────────────────────────────────────────────────────

interface AgentsState {
    agents: Agent[];
    activityFeed: AgentCycle[];
    pendingCheckins: AgentCheckin[];
    chatHistory: Record<string, ChatMessage[]>;
    toolTraces: Record<string, Record<string, Array<{ id: string; name: string; args: string; result?: string }>>>;
    agentFiles: Record<string, FileEntry[]>;
    agentSchedules: Record<string, any>;
    agentLogs: Record<string, AgentCycle[]>;
    availableTools: any[];
    loading: boolean;
    error: string | null;

    fetchAgents: () => Promise<void>;
    fetchActivityFeed: () => Promise<void>;
    fetchPendingCheckins: () => Promise<void>;
    createAgent: (input: CreateAgentInput) => Promise<Agent>;
    startAgent: (id: string) => Promise<void>;
    pauseAgent: (id: string) => Promise<void>;
    stopAgent: (id: string) => Promise<void>;
    interruptAgent: (id: string) => Promise<void>;
    deleteAgent: (id: string) => Promise<void>;
    /** `config` is merged server-side, so send only the keys being changed. */
    updateAgent: (id: string, updates: AgentUpdate) => Promise<void>;
    fetchAgentCycles: (id: string, limit?: number) => Promise<AgentCycle[]>;

    // Chat methods
    fetchAgentChatHistory: (agentId: string) => Promise<void>;
    loadAgentChatFromMessages: (agentId: string) => Promise<void>;
    addChatMessage: (agentId: string, message: ChatMessage) => void;
    upsertChatMessage: (agentId: string, message: ChatMessage) => void;
    updateLastChatMessage: (agentId: string, content: string) => void;
    addToolTrace: (agentId: string, msgId: string, trace: Array<{ id: string; name: string; args: string; result?: string }>) => void;

    // Workspace methods
    fetchAgentFiles: (agentId: string) => Promise<void>;
    fetchAgentSchedule: (agentId: string) => Promise<void>;
    fetchAgentLogs: (agentId: string) => Promise<void>;
    fetchAvailableTools: (agentId?: string) => Promise<void>;
    toggleAgentTool: (agentId: string, toolId: string) => Promise<void>;

    // Real-time socket actions
    patchAgent: (id: string, patch: Partial<Agent>) => void;
    removeAgent: (id: string) => void;
    prependFeedItem: (cycle: AgentCycle) => void;
}

export const useAgentsStore = create<AgentsState>((set, get) => ({
    agents: [],
    activityFeed: [],
    pendingCheckins: [],
    chatHistory: {},
    toolTraces: {},
    agentFiles: {},
    agentSchedules: {},
    agentLogs: {},
    availableTools: [],
    loading: false,
    error: null,

    fetchAgents: async () => {
        set({ loading: true, error: null });
        try {
            const res = await fetch('/api/agents');
            if (!res.ok) throw new Error(`Error ${res.status}: Failed to fetch agents`);
            const data: Agent[] = await res.json();
            set({ agents: data, loading: false });
        } catch (err: any) {
            set({ error: err.message, loading: false });
        }
    },

    fetchActivityFeed: async () => {
        try {
            const res = await fetch('/api/agents/activity');
            if (!res.ok) return;
            const data: AgentCycle[] = await res.json();
            set({ activityFeed: data });
        } catch { /* silent */ }
    },

    fetchPendingCheckins: async () => {
        try {
            const res = await fetch('/api/agents/checkins/pending');
            if (!res.ok) return;
            const data: AgentCheckin[] = await res.json();
            set({ pendingCheckins: data });
        } catch { /* silent */ }
    },

    createAgent: async (input: CreateAgentInput): Promise<Agent> => {
        // When referenceFiles are present, the request must be multipart so the files
        // reach the backend. JSON.stringify silently drops File objects, which is why
        // earlier smoke tests showed empty references/ folders.
        const files = input.referenceFiles;
        let res: Response;
        if (files && files.length > 0) {
            const { referenceFiles, ...rest } = input;
            void referenceFiles;
            const fd = new FormData();
            fd.append('payload', JSON.stringify(rest));
            for (const f of files) fd.append('references', f, f.name);
            // Do NOT set Content-Type — the browser writes the multipart boundary.
            res = await fetch('/api/agents', { method: 'POST', body: fd });
        } else {
            res = await fetch('/api/agents', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(input),
            });
        }
        if (!res.ok) {
            const err = await res.json();
            throw new Error(err.error ?? 'Failed to create agent');
        }
        const agent: Agent = await res.json();
        set(state => ({ agents: [...state.agents, agent] }));
        return agent;
    },

    startAgent: async (id: string) => {
        // Optimistic update
        set(state => ({
            agents: state.agents.map(a => a.id === id ? { ...a, status: 'running' as AgentStatus } : a)
        }));
        try {
            await fetch(`/api/agents/${id}/start`, { method: 'POST' });
        } catch {
            await get().fetchAgents();
        }
    },

    pauseAgent: async (id: string) => {
        set(state => ({
            agents: state.agents.map(a => a.id === id ? { ...a, status: 'paused' as AgentStatus } : a)
        }));
        try {
            await fetch(`/api/agents/${id}/pause`, { method: 'POST' });
        } catch {
            await get().fetchAgents();
        }
    },

    stopAgent: async (id: string) => {
        set(state => ({
            agents: state.agents.map(a => a.id === id ? { ...a, status: 'idle' as AgentStatus } : a)
        }));
        try {
            await fetch(`/api/agents/${id}/stop`, { method: 'POST' });
        } catch {
            await get().fetchAgents();
        }
    },

    interruptAgent: async (id: string) => {
        await fetch(`/api/agents/${id}/interrupt`, { method: 'POST' });
    },

    deleteAgent: async (id: string) => {
        await fetch(`/api/agents/${id}`, { method: 'DELETE' });
        set(state => ({ agents: state.agents.filter(a => a.id !== id) }));
    },

    updateAgent: async (id: string, updates: AgentUpdate) => {
        const res = await fetch(`/api/agents/${id}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(updates),
        });
        if (!res.ok) {
            const err = await res.json();
            throw new Error(err.error ?? 'Failed to update agent');
        }
        const updated: Agent = await res.json();
        set(state => ({
            agents: state.agents.map(a => a.id === id ? updated : a),
        }));
    },

    fetchAgentCycles: async (id: string, limit = 50): Promise<AgentCycle[]> => {
        const res = await fetch(`/api/agents/${id}/cycles?limit=${limit}`);
        if (!res.ok) return [];
        return res.json();
    },

    fetchAgentChatHistory: async (agentId: string) => {
        try {
            const res = await fetch(`/api/agents/${agentId}/chat/history`);
            if (!res.ok) return;
            const data = await res.json();
            const messages: ChatMessage[] = data.messages ?? [];
            // Rebuild toolTraces from the persisted tool_traces column
            const loadedTraces: Record<string, Array<{ id: string; name: string; args: string; result?: string }>> = {};
            for (const msg of messages) {
                if (msg.tool_traces) {
                    try { loadedTraces[msg.id] = JSON.parse(msg.tool_traces); } catch {}
                }
            }
            set(state => ({
                chatHistory: { ...state.chatHistory, [agentId]: messages },
                toolTraces: { ...state.toolTraces, [agentId]: { ...(state.toolTraces[agentId] ?? {}), ...loadedTraces } },
            }));
        } catch { /* silent */ }
    },

    addChatMessage: (agentId, message) => {
        set(state => {
            const existing = state.chatHistory[agentId] || [];
            if (existing.some(m => m.id === message.id)) return {}; // dedup by id
            return {
                chatHistory: {
                    ...state.chatHistory,
                    [agentId]: [...existing, message]
                }
            };
        });
    },

    // Stage 20 gap D — update content if the message id exists, else append.
    // Lets a streamed reply (same id, growing content) render progressively.
    upsertChatMessage: (agentId: string, message: ChatMessage) => {
        set(state => {
            const list = state.chatHistory[agentId] || [];
            const idx = list.findIndex(m => m.id === message.id);
            if (idx >= 0) {
                const copy = [...list];
                copy[idx] = { ...copy[idx], content: message.content };
                return { chatHistory: { ...state.chatHistory, [agentId]: copy } };
            }
            return { chatHistory: { ...state.chatHistory, [agentId]: [...list, message] } };
        });
    },

    // Stage 20 — load an agent's conversation from the unified `messages` table
    // (chat_jid = agent:<id>) instead of the legacy agent_chat_messages endpoint.
    loadAgentChatFromMessages: async (agentId: string) => {
        try {
            const jid = encodeURIComponent(`agent:${agentId}`);
            const res = await fetch(`/api/messages/${jid}?limit=200`);
            if (!res.ok) return;
            const data = await res.json();
            const raw: any[] = data.messages ?? data ?? [];
            const messages: ChatMessage[] = raw.map(m => ({
                id: m.id,
                role: m.is_from_me ? 'user' : 'assistant',
                content: m.content ?? '',
                created_at: m.timestamp ?? m.created_at ?? new Date().toISOString(),
                source: m.source,
            }));
            set(state => ({ chatHistory: { ...state.chatHistory, [agentId]: messages } }));
        } catch { /* silent */ }
    },

    addToolTrace: (agentId, msgId, trace) => {
        set(state => ({
            toolTraces: { ...state.toolTraces, [agentId]: { ...(state.toolTraces[agentId] ?? {}), [msgId]: trace } }
        }));
    },

    updateLastChatMessage: (agentId, content) => {
        set(state => {
            const history = [...(state.chatHistory[agentId] || [])];
            if (history.length > 0) {
                const last = { ...history[history.length - 1], content };
                history[history.length - 1] = last;
            }
            return {
                chatHistory: {
                    ...state.chatHistory,
                    [agentId]: history
                }
            };
        });
    },

    patchAgent: (id, patch) => set(state => ({
        agents: state.agents.map(a => a.id === id ? { ...a, ...patch } : a),
    })),

    removeAgent: (id) => set(state => ({
        agents: state.agents.filter(a => a.id !== id),
    })),

    prependFeedItem: (cycle) => set(state => ({
        activityFeed: [cycle, ...state.activityFeed].slice(0, 50),
    })),
 
    fetchAgentFiles: async (agentId: string) => {
        try {
            const res = await fetch(`/api/files?context=agent&contextId=${agentId}`);
            if (!res.ok) return;
            const data = await res.json();
            set(state => ({
                agentFiles: {
                    ...state.agentFiles,
                    [agentId]: data.files
                }
            }));
        } catch { /* silent */ }
    },
 
    fetchAgentSchedule: async (agentId: string) => {
        try {
            const res = await fetch(`/api/agents/${agentId}/schedule`);
            if (!res.ok) return;
            const data = await res.json();
            set(state => ({
                agentSchedules: {
                    ...state.agentSchedules,
                    [agentId]: data
                }
            }));
        } catch { /* silent */ }
    },
 
    fetchAgentLogs: async (agentId: string) => {
        try {
            const res = await fetch(`/api/agents/${agentId}/cycles?limit=100`);
            if (!res.ok) return;
            const data = await res.json();
            set(state => ({
                agentLogs: {
                    ...state.agentLogs,
                    [agentId]: data
                }
            }));
        } catch { /* silent */ }
    },
 
    fetchAvailableTools: async (agentId?: string) => {
        if (!agentId) return;
        try {
            const res = await fetch(`/api/agents/${agentId}/tools/platform`);
            if (!res.ok) return;
            const data = await res.json();
            set({ availableTools: data.tools ?? [] });
        } catch { /* silent */ }
    },
 
    toggleAgentTool: async (agentId: string, toolId: string) => {
        const state = get();
        const agent = state.agents.find(a => a.id === agentId);
        if (!agent) return;
 
        const tools = agent.config.tools || [];
        const newTools = tools.includes(toolId) 
            ? tools.filter(t => t !== toolId)
            : [...tools, toolId];
 
        await state.updateAgent(agentId, {
            config: { ...agent.config, tools: newTools }
        });
    },
}));
