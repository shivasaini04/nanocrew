// Shared model + task-type catalog for every model-picker in the dashboard
// (Settings → Model Routing, Agent Profile → Models). Single source so adding a
// model means editing one file instead of drifting across pages — this list used
// to be duplicated per-page and already fell out of sync once.
export const MODEL_OPTIONS = [
    { value: 'deepseek/deepseek-v4-pro',       label: 'DeepSeek V4 Pro',       price: '$0.27/M in · $1.10/M out' },
    { value: 'deepseek/deepseek-v4-flash',      label: 'DeepSeek V4 Flash',     price: '$0.14/M in · $0.28/M out' },
    { value: 'gemini/gemini-2.0-flash',         label: 'Gemini 2.0 Flash',      price: '$0.30/M in · $2.50/M out' },
    { value: 'moonshot/kimi-k2.5',              label: 'Moonshot Kimi K2.5',    price: '$1.60/M in · $1.60/M out' },
    { value: 'moonshot/moonshot-v1-8k-vision-preview', label: 'Kimi Vision Preview', price: '$1.20/M in · $1.20/M out' },
    { value: 'groq/llama-3.3-70b-versatile',    label: 'Groq Llama 3.3 70B',   price: '$0.59/M in · $0.79/M out' },
    { value: 'openrouter/inclusionai/ling-3.0-flash',              label: 'OpenRouter: Ling-3.0 Flash',    price: '$0.021/M in · $0.063/M out' },
    { value: 'openrouter/deepseek/deepseek-v4-flash-0731',         label: 'OpenRouter: DeepSeek V4 Flash', price: '$0.14/M in · $0.28/M out' },
    { value: 'openrouter/tencent/hy3',                             label: 'OpenRouter: Tencent Hy3',       price: '$0.126/M in · $0.522/M out' },
    { value: 'openrouter/nvidia/nemotron-3-ultra-550b-a55b:free',  label: 'OpenRouter: Nemotron 3 Ultra (free)', price: '$0/M in · $0/M out — no SLA' },
    { value: 'openrouter/xiaomi/mimo-v2.5',                        label: 'OpenRouter: MiMo-V2.5',         price: '$0.119/M in · $0.238/M out' },
    { value: 'openrouter/z-ai/glm-5.3-flash',                      label: 'OpenRouter: GLM 5.3 Flash',     price: '$0.075/M in · $0.25/M out' },
];

export const TASK_TYPE_LABELS: Record<string, string> = {
    deep_research:     'Deep Research',
    code_generation:   'Code Generation',
    tool_generation:   'Tool Generation',
    summarization:     'Summarization',
    memory_distill:    'Memory Distillation',
    classification:    'Classification',
    vision:            'Vision (image reading)',
    computer_use:      'Computer Use',
};

// The only two task types with a real consumer in the Python agent runtime today
// (loop.py reads VISION_MODEL; nanocrew_adapter.py reads NANOBOT_MEMORY_MODEL for
// memory consolidation). Everything else in TASK_TYPE_LABELS is config-only until
// a taskType argument is actually threaded through the relevant call sites.
export const ACTIVE_TASK_TYPES = ['vision', 'memory_distill'];

export const INACTIVE_TASK_TYPES = Object.keys(TASK_TYPE_LABELS).filter(
    t => !ACTIVE_TASK_TYPES.includes(t),
);
