import { useEffect, useState } from 'react';
import { Settings, Save, Shield, CheckCircle, DollarSign, Layers, ArrowUp, ArrowDown, X, KeyRound, Trash2, Plus, Cpu } from 'lucide-react';
import { useSettingsStore } from '../stores/settingsStore';
import { getModelConfig, updateModelConfig, type ModelConfig } from '../lib/api';
import { MODEL_OPTIONS, TASK_TYPE_LABELS } from '../lib/model-options';

interface CredentialSummary {
    service: string;
    status: 'connected' | 'expired' | 'invalid' | 'not_connected';
    maskedKey: string;
    connectedAt?: string;
    lastUsed?: string;
    usedByAgents: string[];
}

export default function SettingsPage() {
    const { settings, isLoading, isSaving, error, successMessage, fetchSettings, saveSettings } = useSettingsStore();

    useEffect(() => {
        fetchSettings();
    }, [fetchSettings]);

    // Handle form submission
    const handleSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
        e.preventDefault();

        // Extract all inputs into a record
        const formData = new FormData(e.currentTarget);
        const updates: Record<string, string> = {};
        formData.forEach((value, key) => {
            if (typeof value === 'string') {
                updates[key] = value;
            }
        });

        await saveSettings(updates);
    };

    if (isLoading && Object.keys(settings).length === 0) {
        return (
            <div className="crew-page-container">
                <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', padding: '100px 0', gap: '16px' }}>
                    <div className="animate-spin" style={{ width: '32px', height: '32px', border: '3px solid var(--cr-border)', borderTopColor: 'var(--cr-accent)', borderRadius: '50%' }} />
                    <span style={{ color: 'var(--cr-muted-br)', fontFamily: 'var(--cr-font-mono)', fontSize: '12px', letterSpacing: '0.1em' }}>INITIALIZING CONFIGURATION...</span>
                </div>
            </div>
        );
    }

    return (
        <div className="crew-page-container">
            <div className="hero-gradient" style={{ padding: '0 0 40px', marginBottom: '40px' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '16px', marginBottom: '12px' }}>
                    <div style={{ 
                        width: '40px', 
                        height: '40px', 
                        borderRadius: '12px', 
                        background: 'var(--cr-bg-surf)', 
                        border: '1px solid var(--cr-border-bright)',
                        display: 'flex', 
                        alignItems: 'center', 
                        justifyContent: 'center' 
                    }}>
                        <Settings size={22} color="var(--cr-accent)" />
                    </div>
                    <h1 className="font-serif" style={{ fontSize: '32px', color: 'var(--cr-cream)', margin: 0 }}>
                        System Configuration
                    </h1>
                </div>
                <p style={{ color: 'var(--cr-sub)', fontSize: '15px', maxWidth: '600px', lineHeight: 1.6 }}>
                    Manage core environment variables, LLM credentials, and swarm settings.
                </p>
            </div>

            {error && (
                <div style={{ 
                    padding: '16px', 
                    background: 'var(--cr-error-low)', 
                    border: '1px solid var(--cr-error-line)', 
                    borderRadius: '10px', 
                    color: 'var(--cr-error-str)', 
                    marginBottom: '24px', 
                    display: 'flex', 
                    alignItems: 'center', 
                    gap: '10px',
                    fontSize: '14px'
                }}>
                    <Shield size={18} />
                    {error}
                </div>
            )}

            {successMessage && (
                <div style={{ 
                    padding: '16px', 
                    background: 'var(--cr-green-low)', 
                    border: '1px solid var(--cr-green-low)', 
                    borderRadius: '10px', 
                    color: 'var(--cr-green)', 
                    marginBottom: '24px', 
                    display: 'flex', 
                    alignItems: 'center', 
                    gap: '10px',
                    fontSize: '14px',
                    animation: 'crewFadeIn 0.3s ease-out'
                }}>
                    <CheckCircle size={18} />
                    {successMessage}
                </div>
            )}

            <form onSubmit={handleSubmit} style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) 340px', gap: '32px', alignItems: 'flex-start' }}>
                <div className="premium-card" style={{ padding: '40px', borderRadius: '20px' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '32px' }}>
                        <Shield size={20} color="var(--cr-accent)" />
                        <h2 className="font-serif" style={{ fontSize: '22px', color: 'var(--cr-cream)', margin: 0 }}>Core Intelligence Keys</h2>
                    </div>

                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '32px' }}>
                        <ConfigInput
                            id="GROQ_API_KEY"
                            label="Groq Engine"
                            defaultValue={settings['GROQ_API_KEY']}
                            placeholder="gsk_..."
                            helpText="Fast inference for LLaMA-based agents."
                            isSecret
                        />
                        <ConfigInput
                            id="DEEPSEEK_API_KEY"
                            label="DeepSeek Engine"
                            defaultValue={settings['DEEPSEEK_API_KEY']}
                            placeholder="sk-..."
                            helpText="Primary engine for complex reasoning."
                            isSecret
                        />
                        <ConfigInput
                            id="GEMINI_API_KEY"
                            label="Google Gemini"
                            defaultValue={settings['GEMINI_API_KEY']}
                            placeholder="AIza..."
                            helpText="Access to multimodal Flash 2.0 models."
                            isSecret
                        />
                        <ConfigInput
                            id="MOONSHOT_KIMI_API_KEY"
                            label="Moonshot Kimi"
                            defaultValue={settings['MOONSHOT_KIMI_API_KEY']}
                            placeholder="sk-..."
                            helpText="Specialized reasoning capabilities."
                            isSecret
                        />
                    </div>
                </div>

                <div style={{ display: 'flex', flexDirection: 'column', gap: '24px' }}>
                    <div className="premium-card" style={{ padding: '32px', borderRadius: '20px' }}>
                            <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '24px' }}>
                                <Settings size={18} color="var(--cr-sub)" />
                                <h2 className="font-serif" style={{ fontSize: '18px', color: 'var(--cr-cream)', margin: 0 }}>Infrastructure</h2>
                            </div>
                            <ConfigInput
                                id="DASHBOARD_PORT"
                                label="Interface Port"
                                defaultValue={settings['DASHBOARD_PORT']}
                                placeholder="3002"
                                helpText="Restart required to apply."
                            />
                    </div>

                    <PlatformLimitsCard
                        globalBudget={settings['GLOBAL_DAILY_BUDGET_USD'] ?? ''}
                        modelPriority={settings['MODEL_PRIORITY'] ?? ''}
                    />

                    <button
                        type="submit"
                        disabled={isSaving}
                        style={{ 
                            width: '100%',
                            padding: '18px',
                            background: 'linear-gradient(135deg, var(--cr-accent), var(--cr-accent-warm))',
                            border: 'none',
                            borderRadius: '12px',
                            color: 'white',
                            fontFamily: 'var(--cr-font-sans)',
                            fontWeight: 600,
                            fontSize: '14px',
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                            gap: '10px',
                            boxShadow: '0 4px 15px var(--cr-accent-30)',
                            opacity: isSaving ? 0.7 : 1,
                            cursor: isSaving ? 'not-allowed' : 'pointer',
                            transition: 'transform 0.15s'
                        }}
                        onMouseEnter={e => !isSaving && (e.currentTarget.style.transform = 'translateY(-2px)')}
                        onMouseLeave={e => !isSaving && (e.currentTarget.style.transform = 'translateY(0)')}
                    >
                        <Save size={18} />
                        {isSaving ? 'Synchronizing...' : 'Save Swarm Config'}
                    </button>
                </div>
            </form>

            <ModelConfigSection />
            <AgentCredentialsSection />
            <GlobalSecretsSection />
        </div>
    );
}

function ConfigInput({ id, label, defaultValue, placeholder, helpText, isSecret = false }: { id: string, label: string, defaultValue?: string, placeholder?: string, helpText?: string, isSecret?: boolean }) {
    return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
            <label htmlFor={id} style={{ fontSize: '12px', fontWeight: 600, color: 'var(--cr-sub)', letterSpacing: '0.02em' }}>
                {label}
            </label>
            <input
                id={id}
                name={id}
                type={isSecret ? "password" : "text"}
                defaultValue={defaultValue || ''}
                placeholder={placeholder}
                autoComplete="off"
                style={{ 
                    padding: '14px 16px', 
                    borderRadius: '10px',
                    background: 'var(--cr-bg-card)',
                    border: '1px solid var(--cr-border)',
                    color: 'var(--cr-cream)',
                    fontFamily: 'var(--cr-font-mono)',
                    fontSize: '13px',
                    transition: 'all 0.15s'
                }}
                onFocus={e => {
                    e.currentTarget.style.borderColor = 'var(--cr-accent)';
                    e.currentTarget.style.boxShadow = '0 0 0 3px var(--cr-accent-low)';
                }}
                onBlur={e => {
                    e.currentTarget.style.borderColor = 'var(--cr-border)';
                    e.currentTarget.style.boxShadow = 'none';
                }}
            />
            {helpText && (
                <p style={{ fontSize: '11px', color: 'var(--cr-muted-br)', lineHeight: 1.4 }}>{helpText}</p>
            )}
        </div>
    )
}

// Known model IDs the user can add to their priority chain. Keep in sync with
// MODEL_PRICING in nanobot-cycle-runner.ts.
const KNOWN_MODELS = [
    'deepseek/deepseek-chat',
    'deepseek/deepseek-v4-pro',
    'deepseek/deepseek-v4-flash',
    'gemini/gemini-3.5-flash',
    'moonshot/kimi-k2.5',
    'groq/openai/gpt-oss-120b',
    'openrouter/inclusionai/ling-3.0-flash',
    'openrouter/deepseek/deepseek-v4-flash-0731',
    'openrouter/tencent/hy3',
    'openrouter/nvidia/nemotron-3-ultra-550b-a55b:free',
    'openrouter/xiaomi/mimo-v2.5',
    'openrouter/z-ai/glm-5.3-flash',
];

function PlatformLimitsCard({ globalBudget, modelPriority }: { globalBudget: string; modelPriority: string }) {
    const initial = modelPriority.split(',').map(s => s.trim()).filter(Boolean);
    const [chain, setChain] = useState<string[]>(initial);

    // Keep the chain in sync if the parent reloads settings (e.g. after Save).
    useEffect(() => {
        const next = modelPriority.split(',').map(s => s.trim()).filter(Boolean);
        setChain(next);
    }, [modelPriority]);

    const move = (idx: number, dir: -1 | 1) => {
        const j = idx + dir;
        if (j < 0 || j >= chain.length) return;
        const next = [...chain];
        [next[idx], next[j]] = [next[j], next[idx]];
        setChain(next);
    };
    const remove = (idx: number) => setChain(chain.filter((_, i) => i !== idx));
    const add = (id: string) => { if (id && !chain.includes(id)) setChain([...chain, id]); };

    const available = KNOWN_MODELS.filter(m => !chain.includes(m));

    return (
        <div className="premium-card" style={{ padding: '32px', borderRadius: '20px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '24px' }}>
                <DollarSign size={18} color="var(--cr-sub)" />
                <h2 className="font-serif" style={{ fontSize: '18px', color: 'var(--cr-cream)', margin: 0 }}>Platform Limits</h2>
            </div>

            <ConfigInput
                id="GLOBAL_DAILY_BUDGET_USD"
                label="Global Daily Budget Cap (USD)"
                defaultValue={globalBudget}
                placeholder="leave empty for no cap"
                helpText="When total spend across every agent hits this number today, all new cycles are blocked until midnight. Takes effect immediately — no restart."
            />

            <div style={{ display: 'flex', alignItems: 'center', gap: '12px', margin: '28px 0 16px' }}>
                <Layers size={16} color="var(--cr-sub)" />
                <h3 className="font-serif" style={{ fontSize: '15px', color: 'var(--cr-cream)', margin: 0 }}>Model Priority</h3>
            </div>
            <p style={{ fontSize: '11px', color: 'var(--cr-muted-br)', lineHeight: 1.5, marginBottom: '14px' }}>
                Ordered fallback chain. Top model is tried first; lower entries are used if the one above fails or is rate-limited. An empty chain means each agent uses only its own configured model.
            </p>

            {/* Hidden input the form picks up. */}
            <input type="hidden" name="MODEL_PRIORITY" value={chain.join(',')} />

            <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', marginBottom: '14px' }}>
                {chain.length === 0 && (
                    <div style={{ padding: '14px', textAlign: 'center', color: 'var(--cr-muted)', fontSize: '12px', fontStyle: 'italic', border: '1px dashed var(--cr-border)', borderRadius: '10px' }}>
                        No models in chain. Add one below.
                    </div>
                )}
                {chain.map((m, i) => (
                    <div key={m} style={{
                        display: 'flex', alignItems: 'center', gap: '8px',
                        padding: '10px 12px', borderRadius: '10px',
                        background: 'var(--cr-bg-card)', border: '1px solid var(--cr-border)',
                    }}>
                        <span style={{
                            width: '22px', height: '22px', borderRadius: '6px',
                            background: 'var(--cr-accent-low)', color: 'var(--cr-accent)',
                            display: 'flex', alignItems: 'center', justifyContent: 'center',
                            fontFamily: 'var(--cr-font-mono)', fontSize: '11px', fontWeight: 700,
                            flexShrink: 0,
                        }}>{i + 1}</span>
                        <span style={{ flex: 1, fontFamily: 'var(--cr-font-mono)', fontSize: '12px', color: 'var(--cr-cream)' }}>{m}</span>
                        <button type="button" onClick={() => move(i, -1)} disabled={i === 0}
                            style={{ padding: '4px', borderRadius: '6px', background: 'transparent', border: '1px solid var(--cr-border)', color: i === 0 ? 'var(--cr-muted)' : 'var(--cr-sub)', cursor: i === 0 ? 'default' : 'pointer', display: 'flex' }}>
                            <ArrowUp size={12} />
                        </button>
                        <button type="button" onClick={() => move(i, 1)} disabled={i === chain.length - 1}
                            style={{ padding: '4px', borderRadius: '6px', background: 'transparent', border: '1px solid var(--cr-border)', color: i === chain.length - 1 ? 'var(--cr-muted)' : 'var(--cr-sub)', cursor: i === chain.length - 1 ? 'default' : 'pointer', display: 'flex' }}>
                            <ArrowDown size={12} />
                        </button>
                        <button type="button" onClick={() => remove(i)}
                            style={{ padding: '4px', borderRadius: '6px', background: 'transparent', border: '1px solid var(--cr-border)', color: 'var(--cr-muted)', cursor: 'pointer', display: 'flex' }}>
                            <X size={12} />
                        </button>
                    </div>
                ))}
            </div>

            {available.length > 0 && (
                <select
                    onChange={e => { add(e.target.value); e.target.value = ''; }}
                    defaultValue=""
                    style={{
                        width: '100%', padding: '12px 14px', borderRadius: '10px',
                        background: 'var(--cr-bg-card)', border: '1px solid var(--cr-border)',
                        color: 'var(--cr-cream)', fontFamily: 'var(--cr-font-mono)', fontSize: '12px',
                        cursor: 'pointer',
                    }}
                >
                    <option value="" disabled>+ Add model to chain…</option>
                    {available.map(m => <option key={m} value={m}>{m}</option>)}
                </select>
            )}
        </div>
    );
}

function AgentCredentialsSection() {
    const [creds, setCreds] = useState<CredentialSummary[]>([]);
    const [connecting, setConnecting] = useState<string | null>(null);
    const [inputValues, setInputValues] = useState<Record<string, string>>({});
    const [testResults, setTestResults] = useState<Record<string, string>>({});
    const [error, setError] = useState<Record<string, string>>({});

    const SERVICES = [
        { id: 'apollo',  label: 'Apollo.io', placeholder: 'api_key', icon: '🔍', fields: [{ key: 'api_key', label: 'API Key', placeholder: 'apollo_api_key...' }] },
        { id: 'gmail',   label: 'Gmail',     placeholder: 'OAuth',   icon: '📧', fields: [{ key: 'email', label: 'Gmail Address', placeholder: 'you@gmail.com' }, { key: 'refresh_token', label: 'Refresh Token', placeholder: 'OAuth refresh token' }, { key: 'client_id', label: 'Client ID', placeholder: 'Google OAuth client ID' }, { key: 'client_secret', label: 'Client Secret', placeholder: 'Google OAuth client secret' }] },
        { id: 'twitter', label: 'X / Twitter', placeholder: 'bearer_token', icon: '🐦', fields: [{ key: 'bearer_token', label: 'Bearer Token', placeholder: 'AAA...' }] },
        { id: 'hunter',  label: 'Hunter.io', placeholder: 'api_key', icon: '🕵️', fields: [{ key: 'api_key', label: 'API Key', placeholder: 'hunter_api_key...' }] },
        { id: 'linkedin', label: 'LinkedIn', placeholder: 'session_cookie', icon: '💼', fields: [{ key: 'session_cookie', label: 'li_at Cookie', placeholder: 'Paste LinkedIn session cookie' }] },
        // Separate from 'twitter' above on purpose: that one is the official API bearer
        // token, whose search tier costs more than lead research justifies. This one is a
        // browser session, which is what x_search actually drives.
        {
            id: 'x', label: 'X — browser session', placeholder: 'auth_token', icon: '𝕏',
            fields: [
                { key: 'auth_token', label: 'auth_token cookie', placeholder: 'From DevTools → Application → Cookies → x.com' },
                { key: 'ct0', label: 'ct0 cookie', placeholder: 'Must be from the SAME login as auth_token' },
                { key: 'browserbase_api_key', label: 'Browserbase API key (optional)', placeholder: 'Leave empty to use this server’s IP' },
                { key: 'browserbase_project_id', label: 'Browserbase project ID (optional)', placeholder: 'Only needed with the key above' },
            ],
        },
    ];

    useEffect(() => {
        fetch('/api/credentials').then(r => r.ok ? r.json() : []).then(setCreds).catch(() => {});
    }, []);

    const getStatus = (serviceId: string) => creds.find(c => c.service === serviceId) ?? null;

    async function handleSave(serviceId: string, fields: Record<string, string>) {
        setError(e => ({ ...e, [serviceId]: '' }));
        try {
            const res = await fetch(`/api/credentials/${serviceId}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(fields),
            });
            if (!res.ok) throw new Error((await res.json()).error);
            const updated = await fetch('/api/credentials').then(r => r.json()).catch(() => creds);
            setCreds(updated);
            setConnecting(null);
            setTestResults(t => ({ ...t, [serviceId]: '● Connected' }));
        } catch (e: any) {
            setError(err => ({ ...err, [serviceId]: e.message }));
        }
    }

    async function handleTest(serviceId: string) {
        setTestResults(t => ({ ...t, [serviceId]: 'Testing…' }));
        try {
            const res = await fetch(`/api/credentials/${serviceId}/test`, { method: 'POST' });
            const data = await res.json();
            setTestResults(t => ({ ...t, [serviceId]: data.status === 'connected' ? '✓ ' + data.message : '✗ ' + data.message }));
        } catch {
            setTestResults(t => ({ ...t, [serviceId]: '✗ Request failed' }));
        }
    }

    async function handleRemove(serviceId: string) {
        await fetch(`/api/credentials/${serviceId}`, { method: 'DELETE' });
        const updated = await fetch('/api/credentials').then(r => r.json()).catch(() => creds);
        setCreds(updated);
        setTestResults(t => { const n = { ...t }; delete n[serviceId]; return n; });
    }

    return (
        <div style={{ marginTop: '40px' }}>
            <div className="premium-card" style={{ padding: '40px', borderRadius: '24px' }}>
                <div style={{ marginBottom: '32px' }}>
                    <h2 className="font-serif" style={{ fontSize: '22px', color: 'var(--cr-cream)', marginBottom: '8px' }}>
                        Swarm Capabilities
                    </h2>
                    <p style={{ color: 'var(--cr-sub)', fontSize: '14px', maxWidth: '600px' }}>
                        Connect your crew to external services. Credentials are encrypted and isolated within agent containers.
                    </p>
                </div>

                <div style={{ display: 'flex', flexDirection: 'column', gap: '1px', background: 'var(--cr-border)', borderRadius: '16px', overflow: 'hidden', border: '1px solid var(--cr-border)' }}>
                    {SERVICES.map(svc => {
                        const status = getStatus(svc.id);
                        const isConnected = !!status && status.status === 'connected';
                        const isExpanded = connecting === svc.id;
                        const testResult = testResults[svc.id];
                        const errMsg = error[svc.id];

                        return (
                            <div key={svc.id} style={{ background: 'var(--cr-bg-card)', padding: '16px 24px' }}>
                                <div style={{ display: 'flex', alignItems: 'center', gap: '16px' }}>
                                    <div style={{ width: '36px', height: '36px', borderRadius: '10px', background: 'var(--cr-bg-surf)', border: '1px solid var(--cr-border)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '18px' }}>
                                        {svc.icon}
                                    </div>
                                    <div style={{ flex: 1 }}>
                                        <div style={{ fontWeight: 600, fontSize: '14px', color: 'var(--cr-cream)' }}>{svc.label}</div>
                                        {isConnected && status && (
                                            <div style={{ fontSize: '11px', color: 'var(--cr-muted-br)', marginTop: '2px', fontFamily: 'var(--cr-font-mono)' }}>
                                                {status.maskedKey}
                                            </div>
                                        )}
                                    </div>

                                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                                        {testResult && (
                                            <span style={{ fontSize: '11px', fontFamily: 'var(--cr-font-mono)', color: testResult.startsWith('✓') ? 'var(--cr-green)' : testResult === 'Testing…' ? 'var(--cr-sub)' : 'var(--cr-error-str)' }}>
                                                {testResult}
                                            </span>
                                        )}
                                        {isConnected ? (
                                            <>
                                                <button onClick={() => handleTest(svc.id)} style={{ padding: '6px 14px', borderRadius: '8px', background: 'var(--cr-green-low)', border: '1px solid var(--cr-green-low)', color: 'var(--cr-green)', cursor: 'pointer', fontSize: '11px', fontWeight: 600 }}>Verify</button>
                                                <button onClick={() => handleRemove(svc.id)} style={{ padding: '6px 14px', borderRadius: '8px', background: 'var(--cr-error-low)', border: '1px solid var(--cr-error-low)', color: 'var(--cr-error-str)', cursor: 'pointer', fontSize: '11px', fontWeight: 600 }}>Disconnect</button>
                                            </>
                                        ) : (
                                            <button onClick={() => setConnecting(isExpanded ? null : svc.id)} style={{ padding: '8px 20px', borderRadius: '10px', background: 'var(--cr-bg-sidebar)', border: '1px solid var(--cr-border)', color: 'var(--cr-sub)', cursor: 'pointer', fontSize: '12px', fontWeight: 600 }}>
                                                Initialize
                                            </button>
                                        )}
                                    </div>
                                </div>

                                {isExpanded && (
                                    <div style={{ marginTop: '20px', display: 'flex', flexDirection: 'column', gap: '16px', paddingTop: '20px', borderTop: '1px solid var(--cr-border-sub)', animation: 'crewFadeIn 0.2s ease-out' }}>
                                        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '20px' }}>
                                            {svc.fields.map(field => (
                                                <div key={field.key} style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                                                    <label style={{ fontSize: '11px', fontWeight: 600, color: 'var(--cr-muted-br)' }}>{field.label}</label>
                                                    <input
                                                        type="password"
                                                        placeholder={field.placeholder}
                                                        value={inputValues[`${svc.id}.${field.key}`] ?? ''}
                                                        onChange={e => setInputValues(v => ({ ...v, [`${svc.id}.${field.key}`]: e.target.value }))}
                                                        style={{ 
                                                            padding: '10px 14px', 
                                                            borderRadius: '8px', 
                                                            fontSize: '12px', 
                                                            background: 'var(--cr-bg-surf)', 
                                                            border: '1px solid var(--cr-border)', 
                                                            color: 'var(--cr-cream)',
                                                            fontFamily: 'var(--cr-font-mono)' 
                                                        }}
                                                    />
                                                </div>
                                            ))}
                                        </div>
                                        {errMsg && <div style={{ fontSize: '11px', color: 'var(--cr-error-str)', fontFamily: 'var(--cr-font-mono)' }}>Error: {errMsg}</div>}
                                        <div style={{ display: 'flex', gap: '12px' }}>
                                            <button
                                                onClick={() => {
                                                    const fields: Record<string, string> = {};
                                                    svc.fields.forEach(f => { fields[f.key] = inputValues[`${svc.id}.${f.key}`] ?? ''; });
                                                    handleSave(svc.id, fields);
                                                }}
                                                style={{ padding: '10px 24px', borderRadius: '10px', background: 'var(--cr-accent)', color: 'white', border: 'none', cursor: 'pointer', fontSize: '12px', fontWeight: 600 }}
                                            >
                                                Authorize
                                            </button>
                                            <button onClick={() => setConnecting(null)} style={{ padding: '10px 20px', borderRadius: '10px', background: 'none', border: '1px solid var(--cr-border)', color: 'var(--cr-muted)', cursor: 'pointer', fontSize: '12px' }}>
                                                Cancel
                                            </button>
                                        </div>
                                    </div>
                                )}
                            </div>
                        );
                    })}
                </div>
            </div>
        </div>
    );
}

// ─── Global Secrets section ───────────────────────────────────────────────────

interface SecretSummary { name: string; masked: string; createdAt: string; }

function GlobalSecretsSection() {
    const [secrets, setSecrets]   = useState<SecretSummary[]>([]);
    const [newName, setNewName]   = useState('');
    const [newValue, setNewValue] = useState('');
    const [adding, setAdding]     = useState(false);
    const [error, setError]       = useState('');

    const load = () =>
        fetch('/api/secrets').then(r => r.ok ? r.json() : []).then(setSecrets).catch(() => {});

    useEffect(() => { load(); }, []);

    async function handleAdd() {
        setError('');
        if (!newName || !newValue) { setError('Both name and value are required.'); return; }
        try {
            const res = await fetch('/api/secrets', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name: newName.toUpperCase().replace(/\s+/g, '_'), value: newValue }),
            });
            if (!res.ok) { const d = await res.json(); throw new Error(d.error); }
            setNewName(''); setNewValue(''); setAdding(false);
            load();
        } catch (e: any) { setError(e.message); }
    }

    async function handleDelete(name: string) {
        await fetch(`/api/secrets/${name}`, { method: 'DELETE' });
        load();
    }

    return (
        <div style={{ marginTop: '40px' }}>
            <div className="premium-card" style={{ padding: '40px', borderRadius: '24px' }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '28px' }}>
                    <div>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '6px' }}>
                            <KeyRound size={20} color="var(--cr-accent)" />
                            <h2 className="font-serif" style={{ fontSize: '22px', color: 'var(--cr-cream)', margin: 0 }}>
                                Key Vault — Global Secrets
                            </h2>
                        </div>
                        <p style={{ color: 'var(--cr-sub)', fontSize: '14px', maxWidth: '560px' }}>
                            API keys available to all agents. Use agent-specific secrets (on each agent's Secrets tab) to restrict access.
                            Values are encrypted at rest and never shown after saving.
                        </p>
                    </div>
                    <button
                        onClick={() => { setAdding(a => !a); setError(''); }}
                        style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '10px 18px', borderRadius: '10px', background: 'var(--cr-bg-surf)', border: '1px solid var(--cr-border)', color: 'var(--cr-sub)', cursor: 'pointer', fontSize: '12px', fontWeight: 600, flexShrink: 0 }}
                    >
                        <Plus size={14} /> Add Secret
                    </button>
                </div>

                {adding && (
                    <div style={{ padding: '20px', borderRadius: '12px', background: 'var(--cr-bg-surf)', border: '1px solid var(--cr-border)', marginBottom: '20px', display: 'flex', flexDirection: 'column', gap: '16px' }}>
                        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '16px' }}>
                            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                                <label style={{ fontSize: '11px', fontWeight: 600, color: 'var(--cr-muted-br)' }}>NAME (env-var style)</label>
                                <input
                                    placeholder="ELEVENLABS_API_KEY"
                                    value={newName}
                                    onChange={e => setNewName(e.target.value.toUpperCase().replace(/[^A-Z0-9_]/g, '_'))}
                                    style={{ padding: '10px 14px', borderRadius: '8px', background: 'var(--cr-bg-card)', border: '1px solid var(--cr-border)', color: 'var(--cr-cream)', fontFamily: 'var(--cr-font-mono)', fontSize: '13px' }}
                                />
                            </div>
                            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                                <label style={{ fontSize: '11px', fontWeight: 600, color: 'var(--cr-muted-br)' }}>VALUE</label>
                                <input
                                    type="password"
                                    placeholder="sk-..."
                                    value={newValue}
                                    onChange={e => setNewValue(e.target.value)}
                                    autoComplete="new-password"
                                    style={{ padding: '10px 14px', borderRadius: '8px', background: 'var(--cr-bg-card)', border: '1px solid var(--cr-border)', color: 'var(--cr-cream)', fontFamily: 'var(--cr-font-mono)', fontSize: '13px' }}
                                />
                            </div>
                        </div>
                        {error && <div style={{ fontSize: '12px', color: 'var(--cr-error-str)', fontFamily: 'var(--cr-font-mono)' }}>{error}</div>}
                        <div style={{ display: 'flex', gap: '10px' }}>
                            <button onClick={handleAdd} style={{ padding: '9px 22px', borderRadius: '9px', background: 'var(--cr-accent)', color: 'white', border: 'none', cursor: 'pointer', fontSize: '12px', fontWeight: 600 }}>Save</button>
                            <button onClick={() => { setAdding(false); setError(''); setNewName(''); setNewValue(''); }} style={{ padding: '9px 16px', borderRadius: '9px', background: 'none', border: '1px solid var(--cr-border)', color: 'var(--cr-muted)', cursor: 'pointer', fontSize: '12px' }}>Cancel</button>
                        </div>
                    </div>
                )}

                {secrets.length === 0 ? (
                    <div style={{ padding: '32px', textAlign: 'center', border: '1px dashed var(--cr-border)', borderRadius: '12px', color: 'var(--cr-muted)', fontSize: '13px' }}>
                        No global secrets stored.
                    </div>
                ) : (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '1px', background: 'var(--cr-border)', borderRadius: '12px', overflow: 'hidden', border: '1px solid var(--cr-border)' }}>
                        {secrets.map(s => (
                            <div key={s.name} style={{ display: 'flex', alignItems: 'center', gap: '16px', padding: '14px 20px', background: 'var(--cr-bg-card)' }}>
                                <KeyRound size={14} color="var(--cr-accent)" style={{ flexShrink: 0 }} />
                                <span style={{ fontFamily: 'var(--cr-font-mono)', fontSize: '13px', color: 'var(--cr-cream)', flex: 1 }}>{s.name}</span>
                                <span style={{ fontFamily: 'var(--cr-font-mono)', fontSize: '12px', color: 'var(--cr-muted-br)' }}>{s.masked}</span>
                                <span style={{ fontSize: '11px', color: 'var(--cr-muted)', flexShrink: 0 }}>{new Date(s.createdAt).toLocaleDateString()}</span>
                                <button onClick={() => handleDelete(s.name)} style={{ padding: '5px', borderRadius: '7px', background: 'transparent', border: '1px solid var(--cr-border)', color: 'var(--cr-error-str)', cursor: 'pointer', display: 'flex', flexShrink: 0 }}>
                                    <Trash2 size={13} />
                                </button>
                            </div>
                        ))}
                    </div>
                )}
            </div>
        </div>
    );
}

// ─── Model Config ─────────────────────────────────────────────────────────────
// MODEL_OPTIONS / TASK_TYPE_LABELS moved to lib/model-options.ts (shared with
// Agent Profile's Models tab) — imported at the top of this file.

const selStyle: React.CSSProperties = {
    padding: '9px 12px', borderRadius: '8px',
    background: 'var(--cr-bg-card)', border: '1px solid var(--cr-border)',
    color: 'var(--cr-cream)', fontFamily: 'var(--cr-font-mono)', fontSize: '12px',
    cursor: 'pointer', width: '100%',
};

function ModelSelect({ value, onChange }: { value: string; onChange: (v: string) => void }) {
    return (
        <select value={value} onChange={e => onChange(e.target.value)} style={selStyle}>
            {MODEL_OPTIONS.map(o => (
                <option key={o.value} value={o.value}>{o.label}</option>
            ))}
        </select>
    );
}

function ModelConfigSection() {
    const [config, setConfig] = useState<ModelConfig | null>(null);
    const [saving, setSaving] = useState(false);
    const [saved, setSaved] = useState(false);
    const [error, setError] = useState('');

    useEffect(() => {
        getModelConfig().then(setConfig).catch(() => {});
    }, []);

    if (!config) return null;

    const update = (patch: Partial<ModelConfig>) => setConfig(c => c ? { ...c, ...patch } : c);
    const updateTask = (taskType: string, model: string) =>
        setConfig(c => c ? { ...c, taskModels: { ...c.taskModels, [taskType]: model } } : c);

    async function handleSave() {
        if (!config) return;
        setSaving(true); setError('');
        try {
            const updated = await updateModelConfig(config);
            setConfig(updated);
            setSaved(true);
            setTimeout(() => setSaved(false), 2500);
        } catch (e: any) {
            setError(e.message ?? 'Save failed');
        } finally {
            setSaving(false);
        }
    }

    return (
        <div style={{ marginTop: '40px' }}>
            <div className="premium-card" style={{ padding: '40px', borderRadius: '24px' }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '32px' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '14px' }}>
                        <div style={{ width: '36px', height: '36px', borderRadius: '10px', background: 'var(--cr-bg-surf)', border: '1px solid var(--cr-border)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                            <Cpu size={18} color="var(--cr-accent)" />
                        </div>
                        <div>
                            <h2 className="font-serif" style={{ fontSize: '20px', color: 'var(--cr-cream)', margin: 0 }}>Model Routing</h2>
                            <p style={{ color: 'var(--cr-sub)', fontSize: '13px', margin: '4px 0 0' }}>
                                Platform-wide defaults. Per-agent overrides live on each agent's profile.
                            </p>
                        </div>
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                        {saved && <span style={{ color: 'var(--cr-green)', fontSize: '12px', fontFamily: 'var(--cr-font-mono)' }}>Saved</span>}
                        {error && <span style={{ color: 'var(--cr-error-str)', fontSize: '12px', fontFamily: 'var(--cr-font-mono)' }}>{error}</span>}
                        <button onClick={handleSave} disabled={saving}
                            style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '9px 20px', borderRadius: '10px', background: 'var(--cr-accent)', border: 'none', color: 'white', fontSize: '13px', fontWeight: 600, cursor: saving ? 'not-allowed' : 'pointer', opacity: saving ? 0.7 : 1, fontFamily: 'var(--cr-font-sans)' }}>
                            <Save size={14} />
                            {saving ? 'Saving…' : 'Save Models'}
                        </button>
                    </div>
                </div>

                {/* Global default */}
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '24px', marginBottom: '32px', padding: '24px', borderRadius: '14px', background: 'var(--cr-bg-surf)', border: '1px solid var(--cr-border)' }}>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                        <label style={{ fontSize: '11px', fontWeight: 600, color: 'var(--cr-muted-br)', letterSpacing: '0.06em' }}>GLOBAL DEFAULT MODEL</label>
                        <ModelSelect value={config.defaultModel} onChange={v => update({ defaultModel: v })} />
                        <div style={{ fontSize: '11px', color: 'var(--cr-muted)' }}>
                            {MODEL_OPTIONS.find(o => o.value === config.defaultModel)?.price ?? ''}
                        </div>
                        <div style={{ fontSize: '11px', color: 'var(--cr-sub)', marginTop: '2px' }}>
                            Used when no task-type or per-agent override applies.
                        </div>
                    </div>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                        <label style={{ fontSize: '11px', fontWeight: 600, color: 'var(--cr-muted-br)', letterSpacing: '0.06em' }}>THINKING (GLOBAL DEFAULT)</label>
                        <div style={{ display: 'flex', gap: '8px', marginTop: '2px' }}>
                            {(['off', 'on'] as const).map(v => (
                                <button
                                    key={v}
                                    type="button"
                                    onClick={() => update({ thinkingDefault: v === 'on' })}
                                    style={{
                                        flex: 1, padding: '9px', borderRadius: '8px', border: '1px solid var(--cr-border)',
                                        background: (v === 'on') === config.thinkingDefault ? 'var(--cr-accent-low)' : 'var(--cr-bg-card)',
                                        color: (v === 'on') === config.thinkingDefault ? 'var(--cr-accent)' : 'var(--cr-sub)',
                                        fontFamily: 'var(--cr-font-mono)', fontSize: '12px', fontWeight: 700, cursor: 'pointer',
                                        textTransform: 'uppercase',
                                    }}
                                >{v}</button>
                            ))}
                        </div>
                        <div style={{ fontSize: '11px', color: 'var(--cr-muted)' }}>
                            Enables <code style={{ fontSize: '10px' }}>reasoning_content</code> on supporting models. Adds latency + cost. Per-agent override available on agent profile.
                        </div>
                    </div>
                </div>

                {/* Per-task defaults */}
                <div style={{ marginBottom: '8px' }}>
                    <h3 className="font-serif" style={{ fontSize: '16px', color: 'var(--cr-cream)', marginBottom: '6px' }}>Per-Task Defaults</h3>
                    <p style={{ color: 'var(--cr-sub)', fontSize: '12px', marginBottom: '20px' }}>
                        Override the default model for specific task types. Takes precedence over the global default, but can still be overridden per-agent.
                    </p>
                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>
                        {Object.entries(TASK_TYPE_LABELS).map(([taskType, taskLabel]) => {
                            const val = config.taskModels[taskType] ?? config.defaultModel;
                            const priceInfo = MODEL_OPTIONS.find(o => o.value === val);
                            return (
                                <div key={taskType} style={{ display: 'flex', flexDirection: 'column', gap: '6px', padding: '14px', borderRadius: '10px', background: 'var(--cr-bg-surf)', border: '1px solid var(--cr-border)' }}>
                                    <label style={{ fontSize: '11px', fontWeight: 600, color: 'var(--cr-muted-br)', letterSpacing: '0.04em' }}>{taskLabel.toUpperCase()}</label>
                                    <ModelSelect value={val} onChange={m => updateTask(taskType, m)} />
                                    {priceInfo && (
                                        <div style={{ fontSize: '10px', color: 'var(--cr-muted)', fontFamily: 'var(--cr-font-mono)' }}>{priceInfo.price}</div>
                                    )}
                                </div>
                            );
                        })}
                    </div>
                </div>
            </div>
        </div>
    );
}
