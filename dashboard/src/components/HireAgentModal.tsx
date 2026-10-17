import { useEffect, useState } from 'react'
import type { CSSProperties } from 'react'
import { useNavigate } from 'react-router-dom'
import { getAgentTemplates, hireFromTemplate, getBusinessContext, setBusinessContext, type AgentTemplateSummary } from '../lib/api'
import { useAgentsStore } from '../stores/agentsStore'

/**
 * Topic 06 onboarding — "hire a specialist" picker. Two-click hire from a template,
 * or jump into the Recruiter to design a custom agent conversationally.
 */
export default function HireAgentModal({ onClose }: { onClose: () => void }) {
    const navigate = useNavigate()
    const agents = useAgentsStore((s) => s.agents)
    const fetchAgents = useAgentsStore((s) => s.fetchAgents)
    const [templates, setTemplates] = useState<AgentTemplateSummary[]>([])
    const [hiring, setHiring] = useState<string | null>(null)
    const [error, setError] = useState<string | null>(null)
    // Asked once per account, never again. Shown only while unset, so the second
    // hire is a clean two-click flow and the new agent already knows the business.
    const [business, setBusiness] = useState('')
    const [needsBusiness, setNeedsBusiness] = useState(false)

    useEffect(() => {
        getAgentTemplates().then(r => setTemplates(r.templates)).catch(() => setError('Could not load templates'))
        getBusinessContext()
            .then(r => setNeedsBusiness(!r.context))
            .catch(() => { /* non-fatal — just don't ask */ })
    }, [])

    const hire = async (id: string) => {
        setError(null); setHiring(id)
        try {
            // Saved before the hire so the agent's very first cycle already has it.
            // Deliberately not awaited-and-failed: a bad save must never block the
            // hire, which is the action the user actually came here for.
            const typed = business.trim()
            if (needsBusiness && typed) {
                try { await setBusinessContext(typed) } catch { /* non-fatal */ }
            }
            const created = await hireFromTemplate(id)
            await fetchAgents()
            navigate(`/agents/${created.id}?tab=chat`)
            onClose()
        } catch (e) {
            setError(e instanceof Error ? e.message : 'Could not hire')
            setHiring(null)
        }
    }

    const goRecruiter = () => {
        const recruiter = agents.find(a => a.name === 'Recruiter')
        if (recruiter) { navigate(`/agents/${recruiter.id}?tab=chat`); onClose() }
        else setError('No Recruiter found — restart the app to provision one.')
    }

    return (
        <div style={overlay} onClick={onClose}>
            <div style={modal} onClick={e => e.stopPropagation()}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
                    <h2 style={{ margin: 0, fontSize: 18, color: 'var(--cr-text)', fontFamily: 'var(--cr-font-serif, serif)' }}>Hire a specialist</h2>
                    <button onClick={onClose} style={closeBtn}>✕</button>
                </div>
                <p style={{ margin: '0 0 18px', fontSize: 12, color: 'var(--cr-muted)' }}>Describe what you need and the Recruiter builds it with you, or pick a ready-made specialist below.</p>

                {error && <div style={errBox}>{error}</div>}

                {/* Lead option — most hires are "I need something specific", not "which of
                    these four templates is close enough". Describing it to the Recruiter is
                    the primary path now, not a fallback link after four cards. */}
                <button onClick={goRecruiter} disabled={!!hiring} style={primaryBtn}>
                    <div style={{ fontSize: 22 }}>➕</div>
                    <div style={{ flex: 1, textAlign: 'left' }}>
                        <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--cr-text)' }}>Describe your own</div>
                        <div style={{ fontSize: 11, color: 'var(--cr-muted)', marginTop: 2 }}>Tell the Recruiter what you need — it designs the agent with you</div>
                    </div>
                    <div style={{ fontSize: 12, color: 'var(--cr-accent)', fontWeight: 600 }}>Start →</div>
                </button>

                <div style={{ display: 'flex', alignItems: 'center', gap: 10, margin: '18px 0 14px' }}>
                    <div style={{ flex: 1, height: 1, background: 'var(--cr-border)' }} />
                    <span style={{ fontSize: 11, color: 'var(--cr-muted)' }}>or pick a ready-made specialist</span>
                    <div style={{ flex: 1, height: 1, background: 'var(--cr-border)' }} />
                </div>

                {/* One optional line, asked once per account. Every agent hired after
                    this already knows it, which is the point — a new hire that opens
                    already understanding the business is the thing a stateless
                    assistant cannot do. Optional and non-blocking: skipping it costs
                    the user nothing, and they can fill it in later from Account. */}
                {needsBusiness && (
                    <div style={{ marginBottom: 18 }}>
                        <label style={{ display: 'block', fontSize: 12, color: 'var(--cr-sub)', marginBottom: 6 }}>
                            What does your business do? <span style={{ color: 'var(--cr-muted)' }}>(optional)</span>
                        </label>
                        <input
                            value={business}
                            onChange={e => setBusiness(e.target.value)}
                            placeholder="e.g. We run a logistics platform for freight brokers"
                            style={{
                                width: '100%', padding: '9px 11px', fontSize: 13, borderRadius: 8,
                                border: '1px solid var(--cr-border)', background: 'var(--cr-tint-2)',
                                color: 'var(--cr-cream)', boxSizing: 'border-box',
                            }}
                        />
                        <div style={{ fontSize: 11, color: 'var(--cr-muted)', marginTop: 5 }}>
                            Every specialist you hire will know this — you only answer once.
                        </div>
                    </div>
                )}

                <div style={grid}>
                    {templates.map(t => (
                        <button key={t.id} onClick={() => hire(t.id)} disabled={!!hiring} style={cardBtn(hiring === t.id)}>
                            <div style={{ fontSize: 26 }}>{t.emoji}</div>
                            <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--cr-text)', marginTop: 6 }}>{t.name}</div>
                            <div style={{ fontSize: 11, color: 'var(--cr-muted)', marginTop: 4, lineHeight: 1.4 }}>{t.tagline}</div>
                            <div style={{ fontSize: 11, color: 'var(--cr-accent)', marginTop: 10, fontWeight: 600 }}>{hiring === t.id ? 'Hiring…' : 'Hire →'}</div>
                        </button>
                    ))}
                </div>
            </div>
        </div>
    )
}

const overlay: CSSProperties = { position: 'fixed', inset: 0, background: 'var(--cr-scrim)', backdropFilter: 'blur(2px)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 }
const modal: CSSProperties = { width: 560, maxWidth: '92vw', maxHeight: '88vh', overflow: 'auto', background: 'var(--cr-bg-panel)', border: '1px solid var(--cr-border)', borderRadius: 14, padding: 24, boxShadow: '0 30px 80px -20px var(--cr-shade-4)' }
const closeBtn: CSSProperties = { background: 'none', border: 'none', color: 'var(--cr-muted)', fontSize: 16, cursor: 'pointer' }
const primaryBtn: CSSProperties = {
    width: '100%', display: 'flex', alignItems: 'center', gap: 14, textAlign: 'left',
    padding: '16px 18px', borderRadius: 10, cursor: 'pointer',
    border: '1px solid var(--cr-border)', background: 'var(--cr-accent-low)',
}
const grid: CSSProperties = { display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 12, marginBottom: 14 }
const errBox: CSSProperties = { fontSize: 12, color: 'var(--cr-red)', background: 'var(--cr-red-low)', border: '1px solid var(--cr-red-line)', borderRadius: 8, padding: '8px 12px', marginBottom: 12 }
function cardBtn(active: boolean): CSSProperties {
    return { textAlign: 'left', padding: 16, borderRadius: 10, cursor: active ? 'default' : 'pointer', border: '1px solid var(--cr-border)', background: active ? 'var(--cr-blue-low)' : 'var(--cr-tint-1)', transition: 'background 0.15s' }
}
