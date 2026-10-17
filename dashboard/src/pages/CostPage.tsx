import { useEffect, useState, useRef } from 'react';
import { useUsageStore } from '../stores/usageStore';
import { Database, Activity, Calculator, AlertCircle, RefreshCw, ExternalLink, TrendingUp } from 'lucide-react';
import UniversalDrawer from '../components/UniversalDrawer';
import { withAlpha } from '../lib/cr'


// Pricing per 1M tokens. DeepSeek rates are official (api-docs.deepseek.com, checked
// 2026-08-14); the `prompt` figure is the cache-MISS rate because message_tokens does not
// record the cache-hit split. That makes this page an upper bound on chat spend — real
// cache hits are ~50x cheaper on v4. agent_cycles.cost (nanobot-cycle-runner.ts) is the
// accurate number and does use the cache split; that table also carries DeepSeek's
// peak/off-peak rates from 2026-08-16, which this per-model aggregate cannot apply.
const PRICING: Record<string, { prompt: number; completion: number }> = {
    'deepseek/deepseek-v4-flash': { prompt: 0.14, completion: 0.28 },
    'deepseek/deepseek-v4-pro': { prompt: 0.435, completion: 0.87 },
    'deepseek/deepseek-chat': { prompt: 0.27, completion: 1.10 },
    'gemini/gemini-2.0-flash': { prompt: 0.10, completion: 0.40 },
    'moonshot/kimi-k2.5': { prompt: 0.15, completion: 0.60 },
    'groq/llama-3.3-70b-versatile': { prompt: 0.59, completion: 0.79 },
    'openrouter/inclusionai/ling-3.0-flash':             { prompt: 0.021, completion: 0.063 },
    'openrouter/deepseek/deepseek-v4-flash-0731':        { prompt: 0.14,  completion: 0.28  },
    'openrouter/tencent/hy3':                            { prompt: 0.126, completion: 0.522 },
    'openrouter/nvidia/nemotron-3-ultra-550b-a55b:free': { prompt: 0,     completion: 0     },
    'openrouter/xiaomi/mimo-v2.5':                       { prompt: 0.119, completion: 0.238 },
    'openrouter/z-ai/glm-5.3-flash':                     { prompt: 0.075, completion: 0.25  },
    'default': { prompt: 0.435, completion: 0.87 }
};

// ── Spend chart ───────────────────────────────────────────────────────────────

interface DayBucket { date: string; cost: number; tokens: number }

function SpendChart({ data }: { data: DayBucket[] }) {
    const [tooltip, setTooltip] = useState<{ x: number; y: number; d: DayBucket } | null>(null)
    const svgRef = useRef<SVGSVGElement>(null)

    if (data.length === 0) return (
        <div style={{ height: 160, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--cr-muted)', fontSize: 13 }}>
            No spend data yet — costs will appear here once agents run.
        </div>
    )

    const W = 700, H = 140, PAD_L = 48, PAD_R = 12, PAD_T = 12, PAD_B = 28
    const innerW = W - PAD_L - PAD_R
    const innerH = H - PAD_T - PAD_B
    const maxCost = Math.max(...data.map(d => d.cost), 0.0001)
    const barW = Math.max(4, Math.min(28, (innerW / data.length) * 0.7))
    const gap  = innerW / data.length

    // Y-axis labels
    const yTicks = [0, maxCost * 0.5, maxCost]

    // Format short date Mon D
    const fmtDate = (iso: string) => {
        const d = new Date(iso + 'T12:00:00')
        return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
    }

    return (
        <div style={{ position: 'relative', width: '100%' }}>
            <svg
                ref={svgRef}
                viewBox={`0 0 ${W} ${H}`}
                style={{ width: '100%', height: 'auto', overflow: 'visible' }}
                onMouseLeave={() => setTooltip(null)}
            >
                {/* Grid lines */}
                {yTicks.map((v, i) => {
                    const y = PAD_T + innerH - (v / maxCost) * innerH
                    return (
                        <g key={i}>
                            <line x1={PAD_L} x2={W - PAD_R} y1={y} y2={y} stroke="var(--cr-tint-4)" strokeWidth={1} />
                            <text x={PAD_L - 4} y={y + 4} textAnchor="end" fontSize={9} fill="var(--cr-muted)" fontFamily="monospace">
                                ${v.toFixed(v < 0.01 ? 5 : 4)}
                            </text>
                        </g>
                    )
                })}

                {/* Bars */}
                {data.map((d, i) => {
                    const barH = Math.max(2, (d.cost / maxCost) * innerH)
                    const x = PAD_L + i * gap + gap / 2 - barW / 2
                    const y = PAD_T + innerH - barH
                    const isLast = i === data.length - 1

                    return (
                        <g key={d.date}
                            onMouseEnter={(e) => {
                                const rect = svgRef.current?.getBoundingClientRect()
                                if (!rect) return
                                const px = (x + barW / 2) / W * rect.width + rect.left
                                const py = y / H * rect.height + rect.top
                                setTooltip({ x: px, y: py, d })
                            }}
                        >
                            <rect
                                x={x} y={y} width={barW} height={barH}
                                rx={2}
                                fill={isLast ? 'var(--cr-accent)' : 'rgba(var(--cr-accent-rgb),0.45)'}
                                style={{ cursor: 'default', transition: 'fill 0.15s' }}
                            />
                            {/* X label — show every Nth to avoid crowding */}
                            {(data.length <= 14 || i % Math.ceil(data.length / 14) === 0) && (
                                <text
                                    x={x + barW / 2} y={H - 4}
                                    textAnchor="middle" fontSize={8} fill="var(--cr-muted)" fontFamily="monospace"
                                >
                                    {fmtDate(d.date)}
                                </text>
                            )}
                        </g>
                    )
                })}
            </svg>

            {/* Floating tooltip */}
            {tooltip && (
                <div style={{
                    position: 'fixed',
                    left: tooltip.x + 10, top: tooltip.y - 10,
                    background: 'var(--cr-bg-card)', border: '1px solid var(--cr-border)',
                    borderRadius: 8, padding: '8px 12px', pointerEvents: 'none', zIndex: 9999,
                    fontSize: 11, fontFamily: 'var(--cr-font-mono)', lineHeight: 1.6, whiteSpace: 'nowrap',
                    boxShadow: '0 4px 20px var(--cr-shade-2)',
                }}>
                    <div style={{ color: 'var(--cr-cream)', fontWeight: 600, marginBottom: 2 }}>{new Date(tooltip.d.date + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })}</div>
                    <div style={{ color: 'var(--cr-green)' }}>${tooltip.d.cost.toFixed(5)}</div>
                    <div style={{ color: 'var(--cr-muted)' }}>{tooltip.d.tokens.toLocaleString()} tokens</div>
                </div>
            )}
        </div>
    )
}

export default function CostPage() {
    const { summary, sessions, loading, error, fetchUsageData } = useUsageStore();
    const [jobDrawer, setJobDrawer] = useState<{ jobId: string; title: string; resultText: string; isSuccess: boolean } | null>(null);
    const [dailyData, setDailyData] = useState<DayBucket[]>([]);

    useEffect(() => {
        fetchUsageData();
        fetch('/api/usage/daily')
            .then(r => r.ok ? r.json() : [])
            .then((rows: any[]) => {
                // Group by date, summing cost across models
                const byDate: Record<string, DayBucket> = {};
                for (const row of rows) {
                    const cost = calculateCost(row.model, row.prompt, row.completion);
                    if (!byDate[row.date]) byDate[row.date] = { date: row.date, cost: 0, tokens: 0 };
                    byDate[row.date].cost   += cost;
                    byDate[row.date].tokens += row.tokens;
                }
                // Sort oldest → newest for the bar chart
                setDailyData(Object.values(byDate).sort((a, b) => a.date.localeCompare(b.date)).slice(-30));
            })
            .catch(() => {});
    }, []);

    const calculateCost = (model: string, prompt_tokens: number, completion_tokens: number) => {
        const rates = PRICING[model] || PRICING['default'];
        const cost = (prompt_tokens / 1_000_000) * rates.prompt + (completion_tokens / 1_000_000) * rates.completion;
        return cost;
    };

    const totalCost = summary.reduce(
        (sum, row) => sum + calculateCost(row.model, row.total_prompt, row.total_completion),
        0
    );

    const totalTokens = summary.reduce((sum, row) => sum + row.grand_total, 0);

    return (
        <div style={{ flex: 1, display: 'flex', overflow: 'hidden' }}>
            <div className="crew-page-container" style={{ flex: 1, minWidth: 0, overflowY: 'auto' }}>

            <div className="hero-gradient" style={{ padding: '0 0 40px', marginBottom: '40px' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '16px', marginBottom: '12px' }}>
                    <div style={{ 
                        width: '40px', 
                        height: '40px', 
                        borderRadius: '12px', 
                        background: 'var(--cr-accent-low)', 
                        border: '1px solid var(--cr-border-bright)',
                        display: 'flex', 
                        alignItems: 'center', 
                        justifyContent: 'center' 
                    }}>
                        <Calculator size={22} color="var(--cr-accent)" />
                    </div>
                    <h1 className="font-serif" style={{ fontSize: '32px', color: 'var(--cr-cream)', margin: 0 }}>
                        Cost & API Usage
                    </h1>
                </div>
                <p style={{ color: 'var(--cr-sub)', fontSize: '15px', maxWidth: '600px', lineHeight: 1.6 }}>
                    Track LLM token consumption across all your agents and channels with real-time estimates.
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
                    <AlertCircle size={18} />
                    {error}
                </div>
            )}

            {loading && summary.length === 0 ? (
                <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', padding: '100px 0', gap: '16px' }}>
                    <RefreshCw className="animate-spin" size={32} color="var(--cr-accent)" />
                    <span style={{ color: 'var(--cr-muted-br)', fontFamily: 'var(--cr-font-mono)', fontSize: '12px', letterSpacing: '0.1em' }}>SYNCHRONIZING USAGE DATA...</span>
                </div>
            ) : (
                <div style={{ animation: 'crewFadeIn 0.5s ease-out' }}>
                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '20px', marginBottom: '40px' }}>
                        {[
                            { label: 'Estimated Cost', value: `$${totalCost.toFixed(4)}`, icon: <Calculator size={18} />, sub: 'Approximate API spending', color: 'var(--cr-accent)' },
                            { label: 'Total Tokens', value: totalTokens.toLocaleString(), icon: <Database size={18} />, sub: 'Across all active models', color: 'var(--cr-blue)' },
                            { label: 'Active Sessions', value: sessions.length, icon: <Activity size={18} />, sub: 'Generating API requests', color: 'var(--cr-purple)' },
                        ].map((stat, i) => (
                            <div key={i} className="premium-card" style={{ padding: '24px', borderRadius: '14px', position: 'relative', overflow: 'hidden' }}>
                                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '16px' }}>
                                    <span style={{ fontSize: '11px', fontWeight: 600, color: 'var(--cr-muted-br)', textTransform: 'uppercase', letterSpacing: '0.08em' }}>{stat.label}</span>
                                    <div style={{ color: stat.color, opacity: 0.8 }}>{stat.icon}</div>
                                </div>
                                <div className="font-serif" style={{ fontSize: '28px', color: 'var(--cr-cream)', marginBottom: '6px' }}>{stat.value}</div>
                                <div style={{ fontSize: '12px', color: 'var(--cr-sub)' }}>{stat.sub}</div>
                                {/* Subtle decorative gradient */}
                                <div style={{ position: 'absolute', top: 0, right: 0, width: '40px', height: '40px', background: `radial-gradient(circle at top right, ${withAlpha(stat.color, 8)}, transparent 70%)` }} />
                            </div>
                        ))}
                    </div>

                    {/* Spend over time chart */}
                    <div className="premium-card" style={{ marginBottom: '32px', padding: '24px', borderRadius: '14px' }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '20px' }}>
                            <TrendingUp size={18} color="var(--cr-accent)" />
                            <h2 className="font-serif" style={{ fontSize: '20px', color: 'var(--cr-cream)', margin: 0 }}>Spend Over Time</h2>
                            <span style={{ marginLeft: 'auto', fontSize: 11, color: 'var(--cr-muted)', fontFamily: 'var(--cr-font-mono)' }}>last 30 days</span>
                        </div>
                        <SpendChart data={dailyData} />
                    </div>

                    <div style={{ display: 'grid', gridTemplateColumns: '1.2fr 1fr', gap: '32px' }}>
                        {/* Usage by Model */}
                        <div className="premium-card" style={{ border: 'none', background: 'transparent' }}>
                            <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '24px' }}>
                                <Database size={18} color="var(--cr-accent)" />
                                <h2 className="font-serif" style={{ fontSize: '20px', color: 'var(--cr-cream)', margin: 0 }}>Usage by Model</h2>
                            </div>
                            <div style={{ background: 'var(--cr-bg-card)', border: '1px solid var(--cr-border)', borderRadius: '12px', overflow: 'hidden' }}>
                                <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                                    <thead>
                                        <tr style={{ borderBottom: '1px solid var(--cr-border)', background: 'var(--cr-tint-1)' }}>
                                            <th style={{ padding: '14px 20px', textAlign: 'left', fontSize: '11px', color: 'var(--cr-muted-br)', fontWeight: 600, textTransform: 'uppercase' }}>Model</th>
                                            <th style={{ padding: '14px 20px', textAlign: 'right', fontSize: '11px', color: 'var(--cr-muted-br)', fontWeight: 600, textTransform: 'uppercase' }}>Prompt</th>
                                            <th style={{ padding: '14px 20px', textAlign: 'right', fontSize: '11px', color: 'var(--cr-muted-br)', fontWeight: 600, textTransform: 'uppercase' }}>Completion</th>
                                            <th style={{ padding: '14px 20px', textAlign: 'right', fontSize: '11px', color: 'var(--cr-muted-br)', fontWeight: 600, textTransform: 'uppercase' }}>Est. Cost</th>
                                        </tr>
                                    </thead>
                                    <tbody style={{ fontFamily: 'var(--cr-font-mono)', fontSize: '12px' }}>
                                        {summary.length === 0 ? (
                                            <tr><td colSpan={4} style={{ padding: '40px', textAlign: 'center', color: 'var(--cr-muted)' }}>No usage data logged yet.</td></tr>
                                        ) : (
                                            summary.map((row) => (
                                                <tr key={row.model} style={{ borderBottom: '1px solid var(--cr-border-sub)' }}>
                                                    <td style={{ padding: '14px 20px', color: 'var(--cr-text)' }}>{row.model}</td>
                                                    <td style={{ padding: '14px 20px', textAlign: 'right', color: 'var(--cr-sub)' }}>{row.total_prompt.toLocaleString()}</td>
                                                    <td style={{ padding: '14px 20px', textAlign: 'right', color: 'var(--cr-sub)' }}>{row.total_completion.toLocaleString()}</td>
                                                    <td style={{ padding: '14px 20px', textAlign: 'right', color: 'var(--cr-green)' }}>
                                                        ${calculateCost(row.model, row.total_prompt, row.total_completion).toFixed(4)}
                                                    </td>
                                                </tr>
                                            ))
                                        )}
                                    </tbody>
                                </table>
                            </div>
                        </div>

                        {/* Recent Sessions */}
                        <div className="premium-card" style={{ border: 'none', background: 'transparent' }}>
                            <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '24px' }}>
                                <Activity size={18} color="var(--cr-purple)" />
                                <h2 className="font-serif" style={{ fontSize: '20px', color: 'var(--cr-cream)', margin: 0 }}>Recent Sessions</h2>
                            </div>
                            <div style={{ background: 'var(--cr-bg-card)', border: '1px solid var(--cr-border)', borderRadius: '12px', overflow: 'hidden' }}>
                                <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                                    <thead style={{ position: 'sticky', top: 0, zIndex: 1, background: 'var(--cr-bg-card)' }}>
                                        <tr style={{ borderBottom: '1px solid var(--cr-border)', background: 'var(--cr-tint-1)' }}>
                                            <th style={{ padding: '14px 20px', textAlign: 'left', fontSize: '11px', color: 'var(--cr-muted-br)', fontWeight: 600, textTransform: 'uppercase' }}>Session ID</th>
                                            <th style={{ padding: '14px 20px', textAlign: 'right', fontSize: '11px', color: 'var(--cr-muted-br)', fontWeight: 600, textTransform: 'uppercase' }}>Tokens</th>
                                            <th style={{ padding: '14px 20px', textAlign: 'right', fontSize: '11px', color: 'var(--cr-muted-br)', fontWeight: 600, textTransform: 'uppercase' }}>Details</th>
                                        </tr>
                                    </thead>
                                    <tbody style={{ fontFamily: 'var(--cr-font-mono)', fontSize: '12px' }}>
                                        {sessions.length === 0 ? (
                                            <tr><td colSpan={3} style={{ padding: '40px', textAlign: 'center', color: 'var(--cr-muted)' }}>No session data logged yet.</td></tr>
                                        ) : (
                                            sessions.slice(0, 20).map((session) => (
                                                <tr key={session.session_id} 
                                                    style={{ borderBottom: '1px solid var(--cr-border-sub)', transition: 'background 0.15s' }}
                                                    className="hover-row"
                                                >
                                                    <td style={{ padding: '14px 20px', color: 'var(--cr-text)' }} title={session.session_id}>
                                                        {session.session_id.split(':').pop()?.slice(0, 12)}…
                                                    </td>
                                                    <td style={{ padding: '14px 20px', textAlign: 'right', color: 'var(--cr-sub)' }}>{session.grand_total.toLocaleString()}</td>
                                                    <td style={{ padding: '14px 20px', textAlign: 'right' }}>
                                                        <button 
                                                            onClick={() => setJobDrawer({
                                                                jobId: session.session_id.split(':').pop() || session.session_id,
                                                                title: `Session: ${session.model}`,
                                                                resultText: `Usage session for ${session.model}. ${session.grand_total} tokens consumed.`,
                                                                isSuccess: true
                                                            })}
                                                            style={{ 
                                                                background: 'none', border: 'none', color: 'var(--cr-accent)', 
                                                                cursor: 'pointer', padding: '4px', display: 'inline-flex', alignItems: 'center', gap: '4px' 
                                                            }}
                                                        >
                                                            <ExternalLink size={14} />
                                                        </button>
                                                    </td>
                                                </tr>
                                            ))
                                        )}
                                    </tbody>
                                </table>
                            </div>
                        </div>
                    </div>
                </div>
            )}
            </div>

            {/* Artifact Drawer */}
            {jobDrawer && (
                <UniversalDrawer
                    jobId={jobDrawer.jobId}
                    title={jobDrawer.title}
                    resultText={jobDrawer.resultText}
                    isSuccess={jobDrawer.isSuccess}
                    onClose={() => setJobDrawer(null)}
                />
            )}
        </div>
    );
}
