const API_BASE = '/api'

export async function fetchApi<T>(endpoint: string, options?: RequestInit): Promise<T> {
    const res = await fetch(`${API_BASE}${endpoint}`, options);
    if (!res.ok) throw new Error(`API error: ${res.status} ${res.statusText}`);
    return res.json();
}

// --- Types matching the backend ---

export interface SystemStatus {
    status: string
    uptime: number
    uptimeHuman: string
    registeredGroups: number
    totalChats: number
    timestamp: string
    costToday?: number
}

export interface RegisteredGroup {
    jid: string
    name: string
    folder: string
    trigger: string
    added_at: string
    requiresTrigger?: boolean
}

export interface ChatInfo {
    jid: string
    name: string
    last_message_time: string
    channel: string
    is_group: number
}

export interface ContainerInfo {
    name: string
    status: string
    image: string
    created: string
    ports: string
}

export interface ContainersResponse {
    containers: ContainerInfo[]
    count: number
    error?: string
}

export interface ScheduledTask {
    id: string
    group_folder: string
    chat_jid: string
    prompt: string
    schedule_type: 'cron' | 'interval' | 'once'
    schedule_value: string
    context_mode: string
    next_run: string | null
    last_run: string | null
    last_result: string | null
    status: 'active' | 'paused' | 'completed'
    created_at: string
}

// --- API functions ---

export const getStatus = () => fetchApi<SystemStatus>('/status')
export const getGroups = () => fetchApi<RegisteredGroup[]>('/groups')
export const getChats = () => fetchApi<ChatInfo[]>('/chats')
export const getContainers = () => fetchApi<ContainersResponse>('/containers')
export const getSettings = () => fetchApi('/settings');
export const updateSettings = (settings: Record<string, any>) =>
    fetchApi('/settings', { method: 'POST', body: JSON.stringify(settings) });

export const getTasks = () => fetchApi<ScheduledTask[]>('/tasks')
export const createTask = (task: Partial<ScheduledTask>) =>
    fetchApi<ScheduledTask>('/tasks', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(task) });
export const updateTask = (id: string, updates: Partial<ScheduledTask>) =>
    fetchApi<{ success: true }>(`/tasks/${id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(updates) });
export const deleteTask = (id: string) =>
    fetchApi<{ success: true }>(`/tasks/${id}`, { method: 'DELETE' });

// Cost & Usage API
export const getUsageSummary = () => fetchApi('/usage/summary');
export const getSessionUsage = () => fetchApi('/usage/sessions');

// Files & Workspace API
export const getMemory = (folder: string) => fetchApi<{ memoryMd: string; historyMd: string }>(`/groups/${folder}/memory`);
export const getSkills = (folder: string) => fetchApi<Array<{ name: string; files: Array<{ filename: string; content: string }> }>>(`/groups/${folder}/skills`);


// Agent API
export const getAgents = () => fetchApi('/agents');
export const getAgent = (id: string) => fetchApi(`/agents/${id}`);
export const createAgent = (input: unknown) => {
    // Phase A5 Task 1.2 — if referenceFiles are present, switch to multipart so the files reach the backend.
    // Otherwise stay on JSON for simplicity + backwards-compat with existing callers.
    const i = input as { referenceFiles?: File[] } & Record<string, unknown>;
    const files = i?.referenceFiles;
    if (files && files.length > 0) {
        const { referenceFiles, ...rest } = i;
        void referenceFiles;
        const fd = new FormData();
        fd.append('payload', JSON.stringify(rest));
        for (const f of files) fd.append('references', f, f.name);
        // NOTE: do NOT set Content-Type — the browser writes the multipart boundary for us.
        return fetchApi('/agents', { method: 'POST', body: fd });
    }
    return fetchApi('/agents', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) });
};
export const updateAgent = (id: string, updates: unknown) =>
    fetchApi(`/agents/${id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(updates) });
export const startAgent     = (id: string) => fetchApi(`/agents/${id}/start`,     { method: 'POST' });
export const pauseAgent     = (id: string) => fetchApi(`/agents/${id}/pause`,     { method: 'POST' });
export const stopAgent      = (id: string) => fetchApi(`/agents/${id}/stop`,      { method: 'POST' });
export const interruptAgent = (id: string) => fetchApi(`/agents/${id}/interrupt`, { method: 'POST' });
export const deleteAgent = (id: string) => fetchApi(`/agents/${id}`, { method: 'DELETE' });
export const getAgentCycles = (id: string, limit = 50) => fetchApi(`/agents/${id}/cycles?limit=${limit}`);
export const getAgentMemory = (id: string) => fetchApi(`/agents/${id}/memory`);
export const getAgentCheckins = (id: string) => fetchApi(`/agents/${id}/checkins`);
export const getPendingCheckins = () => fetchApi('/agents/checkins/pending');
export const getAgentActivity = () => fetchApi('/agents/activity');
// Agent templates (onboarding — Topic 06)
export interface AgentTemplateSummary { id: string; name: string; emoji: string; tagline: string; role: string }
export const getAgentTemplates = () => fetchApi<{ templates: AgentTemplateSummary[] }>('/agents/templates');
export const hireFromTemplate = (templateId: string) =>
    fetchApi<{ id: string; name: string }>('/agents/from-template', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ templateId }) });

export const triggerCycle = (id: string, cycleType: string) =>
    fetchApi(`/agents/${id}/cycle`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ cycleType }) });

// Check-in API
export const getAgentCheckinList = (id: string) => fetchApi(`/agents/${id}/checkins`);
export const getPendingCheckinForAgent = (id: string) => fetchApi(`/agents/${id}/checkins/pending`);
export const getCheckin = (agentId: string, checkinId: string) => fetchApi(`/agents/${agentId}/checkins/${checkinId}`);
export const respondToCheckin = (agentId: string, checkinId: string, reply: string) =>
    fetchApi(`/agents/${agentId}/checkins/${checkinId}/respond`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reply }),
    });

// Tool approvals (Strict posture) — an agent is blocked mid-cycle awaiting each of these.
export interface ToolApproval {
    id: string;
    agent_id: string;
    cycle_id: string | null;
    tool: string;
    args_preview: string | null;
    reason: string | null;
    status: 'pending' | 'approved' | 'denied' | 'expired';
    created_at: string;
}
export const getPendingApprovals = () => fetchApi<ToolApproval[]>('/account/approvals');
export const respondToApproval = (agentId: string, approvalId: string, decision: 'approve' | 'deny', note?: string) =>
    fetchApi<ToolApproval>(`/agents/${agentId}/tool-approvals/${approvalId}/respond`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ decision, note }),
    });

// Security posture
export const getSecurityPosture = () => fetchApi<{ posture: string; selectable: string[] }>('/account/security');
export const setSecurityPosture = (posture: string) =>
    fetchApi<{ ok: boolean; posture: string }>('/account/security', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ posture }),
    });

// Memory API
export const addMemory = (agentId: string, type: string, content: string) =>
    fetchApi(`/agents/${agentId}/memory`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ type, content }) });
export const deleteMemory = (agentId: string, memoryId: string) =>
    fetchApi(`/agents/${agentId}/memory/${memoryId}`, { method: 'DELETE' });
/** The live IDENTITY.md — read-only; it is regenerated from config, not edited directly. */
export const getIdentity = (agentId: string) =>
    fetchApi<{ content: string; version: number; editable: Record<string, string | null> }>(`/agents/${agentId}/identity`);
export const getIdentityHistory = (agentId: string) =>
    fetchApi(`/agents/${agentId}/identity-history`);
export const getIdentityVersion = (agentId: string, version: number) =>
    fetchApi(`/agents/${agentId}/identity-history/${version}`);

// Credential API
export const getCredentials = () => fetchApi('/credentials');
export const saveCredential = (service: string, fields: Record<string, string>) =>
    fetchApi(`/credentials/${service}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(fields) });
export const deleteCredential = (service: string) =>
    fetchApi(`/credentials/${service}`, { method: 'DELETE' });
export const testCredential = (service: string) =>
    fetchApi(`/credentials/${service}/test`, { method: 'POST' });

// Model Config API
export interface ModelConfig {
    defaultModel: string;
    fallbackChain: string[];
    thinkingDefault: boolean;
    taskModels: Record<string, string>;
}

export const getModelConfig = (): Promise<ModelConfig> => fetchApi('/model-config');
export const updateModelConfig = (config: Partial<ModelConfig>): Promise<ModelConfig> =>
    fetchApi('/model-config', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(config) });

// Admin API (operator-only — all require an admin session)
export interface AdminClient {
    id: string; email: string; role: 'admin' | 'user'; status: 'active' | 'suspended';
    plan: string | null; created_at: string; last_active: string | null;
    agent_count: number; cycle_count: number; cost: number;
}
export const getAdminStats = () => fetchApi<{ totalClients: number; activeThisMonth: number; totalCycles: number; totalCost: number }>('/admin/stats');
export const getAdminClients = () => fetchApi<{ clients: AdminClient[] }>('/admin/clients');
export const getAdminClient = (id: string) => fetchApi<{ user: AdminClient; agents: Array<{ id: string; name: string; emoji: string | null; status: string; cycles: number; cost: number; last_active: string | null }> }>(`/admin/clients/${id}`);
export const updateAdminClient = (id: string, patch: { status?: 'active' | 'suspended'; plan?: string | null }) =>
    fetchApi<AdminClient>(`/admin/clients/${id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch) });
export const deleteAdminClient = (id: string) =>
    fetchApi<{ ok: true; deletedAgents: number }>(`/admin/clients/${id}`, { method: 'DELETE' });
export const resetClientPassword = (id: string) =>
    mutate<{ ok: true; password?: string }>(`/admin/clients/${id}/reset-password`, 'POST');
// ── Client Account (every logged-in user) ───────────────────────────────────
export interface AccountInfo {
    user: { id: string; email: string; role: string; plan: string | null; created_at: string }
    usage: { cyclesThisMonth: number; cycleLimit: number; agentCount: number; agentLimit: number | null; projectCount: number; projectLimit: number | null }
    byok: { provider: string | null; hasKey: boolean; model: string | null }
    byokProviders: string[]
    byokAllowed: boolean
    defaultModel: string | null
}
export const getAccount = () => fetchApi<AccountInfo>('/account');

/** Three concrete opening jobs for an agent's empty chat. Generated on first call, then cached. */
export const getAgentStarters = (agentId: string) =>
    fetchApi<{ starters: string[] }>(`/agents/${agentId}/starters`);

/** What this owner's whole crew knows about their business. Set once, shared by every agent. */
export const getBusinessContext = () =>
    fetchApi<{ context: string; maxLength: number }>('/account/business');
const mutate = async <T>(endpoint: string, method: string, body?: unknown): Promise<T> => {
    const res = await fetch(`${API_BASE}${endpoint}`, {
        method, headers: body ? { 'Content-Type': 'application/json' } : undefined,
        body: body ? JSON.stringify(body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error((data as { error?: string }).error || `API error: ${res.status}`);
    return data as T;
};
export const changePassword = (currentPassword: string, newPassword: string) =>
    mutate<{ ok: true }>('/account/password', 'POST', { currentPassword, newPassword });
export const setByok = (provider: string, apiKey: string, model?: string) =>
    mutate<{ ok: true; provider: string }>('/account/byok', 'PUT', { provider, apiKey, model });
export const clearByok = () => mutate<{ ok: true }>('/account/byok', 'DELETE');
export const setAccountDefaultModel = (model: string) =>
    mutate<{ ok: true }>('/account/default-model', 'PUT', { model });
export const clearAccountDefaultModel = () => mutate<{ ok: true }>('/account/default-model', 'DELETE');
export const setBusinessContext = (context: string) =>
    mutate<{ ok: true; context: string }>('/account/business', 'PUT', { context });
// Fired once from the mobile gate — lets the operator know there's demand for a mobile app.
export const reportMobileInterest = () =>
    mutate<{ ok: true }>('/account/mobile-interest', 'POST');
// WhatsApp (Stage 30) — connect/status/disconnect. QR + state arrive over socket.io.
export const getWhatsApp = () => fetchApi<{ state: string; number: string | null }>('/account/whatsapp');
export const connectWhatsApp = () => mutate<{ ok: true; state: string; number: string | null }>('/account/whatsapp/connect', 'POST');
export const disconnectWhatsApp = () => mutate<{ ok: true }>('/account/whatsapp/disconnect', 'POST');

// Phone notifications (stage 64 phase 1) — approvals and questions on the owner's WhatsApp.
export interface NotifyPrefs { whatsapp: boolean; phone: string | null; telegramChatId?: string | null; quietStart: string | null; quietEnd: string | null }
/** telegram = the NanoCrew bot (rings, tap to answer); contact = a separate WhatsApp notifier number (rings); self = your own "Message yourself" chat (silent). */
export interface NotifyDelivery { mode: 'telegram' | 'contact' | 'self' | 'none'; to: string | null; from: string | null }
export interface TelegramStatus { available: boolean; botUsername: string | null; linked: boolean }
export const getNotifySettings = () => fetchApi<{ prefs: NotifyPrefs; delivery: NotifyDelivery; telegram: TelegramStatus }>('/account/notify');
export const setNotifySettings = (prefs: Partial<NotifyPrefs>) =>
    mutate<{ prefs: NotifyPrefs; delivery: NotifyDelivery; telegram: TelegramStatus }>('/account/notify', 'PUT', prefs);
export const sendNotifyTest = () => mutate<{ sent: true; delivery: NotifyDelivery }>('/account/notify/test', 'POST');
export interface TelegramLink { code: string; botUsername: string; url: string; expiresInMin: number }
export const linkTelegram = () => mutate<TelegramLink>('/account/notify/telegram/link', 'POST');
export const unlinkTelegram = () => mutate<{ ok: true; delivery: NotifyDelivery; telegram: TelegramStatus }>('/account/notify/telegram/unlink', 'POST');

// Tail a production container's logs (admin-only). Returns plain text.
export const getAdminLogs = async (service: string, lines = 500): Promise<string> => {
    const res = await fetch(`${API_BASE}/admin/logs?service=${encodeURIComponent(service)}&lines=${lines}`);
    if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        throw new Error((d as { error?: string }).error || `API error: ${res.status}`);
    }
    return res.text();
};
// Create a client account (invite-only onboarding). Parses the server's error body so the
// UI can show "email already exists" etc. instead of a bare status code.
export const createAdminClient = async (input: { email: string; password?: string; plan?: string | null }): Promise<{ user: AdminClient; tempPassword?: string }> => {
    const res = await fetch(`${API_BASE}/admin/clients`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error((data as { error?: string }).error || `API error: ${res.status}`);
    return data as { user: AdminClient; tempPassword?: string };
};

// Handoff API
export const getAgentHandoffs = (agentId: string) => fetchApi(`/agents/${agentId}/handoffs`);
export const getPendingAgentHandoffs = (agentId: string) => fetchApi(`/agents/${agentId}/handoffs/pending`);
export const createHandoff = (agentId: string, toAgentId: string, type: string, payload: unknown, note?: string) =>
    fetchApi(`/agents/${agentId}/handoffs`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ toAgentId, type, payload, note }) });
