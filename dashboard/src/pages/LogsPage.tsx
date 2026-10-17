import { useEffect, useRef, useState } from 'react'
import type { CSSProperties } from 'react'
import { getAdminLogs } from '../lib/api'

// Admin-only production log viewer. Tails the prod containers via /api/admin/logs so the
// operator can debug live without SSH. (Topic 10 — monitoring.)
const SERVICES = [
    { id: 'orchestrator', label: 'Orchestrator' },
    { id: 'litellm', label: 'LiteLLM (models)' },
    { id: 'reacher', label: 'Reacher (email)' },
]

export default function LogsPage() {
    const [service, setService] = useState('orchestrator')
    const [logs, setLogs] = useState('')
    const [loading, setLoading] = useState(false)
    const [error, setError] = useState<string | null>(null)
    const [auto, setAuto] = useState(false)
    const preRef = useRef<HTMLPreElement>(null)

    const load = async (svc = service) => {
        setLoading(true); setError(null)
        try {
            const text = await getAdminLogs(svc, 600)
            setLogs(text)
            requestAnimationFrame(() => { if (preRef.current) preRef.current.scrollTop = preRef.current.scrollHeight })
        } catch (e) {
            setError(e instanceof Error ? e.message : 'Failed to load logs')
        } finally {
            setLoading(false)
        }
    }

    useEffect(() => { load(service) /* eslint-disable-next-line */ }, [service])
    useEffect(() => {
        if (!auto) return
        const t = setInterval(() => load(service), 5000)
        return () => clearInterval(t)
        // eslint-disable-next-line
    }, [auto, service])

    const tab = (active: boolean): CSSProperties => ({
        padding: '7px 14px', fontSize: 12, fontWeight: 600, borderRadius: 8, cursor: 'pointer',
        border: `1px solid ${active ? 'var(--cr-border-bright)' : 'var(--cr-border)'}`,
        background: active ? 'var(--cr-accent-low)' : 'var(--cr-tint-2)',
        color: active ? 'var(--cr-cream)' : 'var(--cr-muted)',
    })

    return (
        <div style={{ padding: '28px 32px', maxWidth: 1280, margin: '0 auto' }}>
            <h1 style={{ fontFamily: 'var(--cr-font-serif, serif)', fontSize: 26, color: 'var(--cr-cream)', margin: 0 }}>Logs</h1>
            <div style={{ fontSize: 13, color: 'var(--cr-muted)', marginTop: 4 }}>Live production container logs — for debugging without SSH.</div>

            <div style={{ display: 'flex', gap: 8, marginTop: 18, alignItems: 'center', flexWrap: 'wrap' }}>
                {SERVICES.map(s => (
                    <button key={s.id} onClick={() => setService(s.id)} style={tab(service === s.id)}>{s.label}</button>
                ))}
                <div style={{ flex: 1 }} />
                <label style={{ fontSize: 12, color: 'var(--cr-sub)', display: 'flex', gap: 6, alignItems: 'center', cursor: 'pointer' }}>
                    <input type="checkbox" checked={auto} onChange={e => setAuto(e.target.checked)} /> Auto-refresh (5s)
                </label>
                <button onClick={() => load(service)} disabled={loading}
                    style={{ padding: '7px 14px', fontSize: 12, fontWeight: 600, borderRadius: 8, border: '1px solid var(--cr-border)', background: 'var(--cr-accent)', color: 'var(--cr-on-accent)', cursor: loading ? 'default' : 'pointer', opacity: loading ? 0.6 : 1 }}>
                    {loading ? 'Loading…' : 'Refresh'}
                </button>
            </div>

            {error && <div style={{ marginTop: 12, color: 'var(--cr-red)', fontSize: 13 }}>{error}</div>}

            <pre ref={preRef} style={{
                marginTop: 14, height: 'calc(100vh - 230px)', overflow: 'auto',
                background: 'var(--cr-well-str)', border: '1px solid var(--cr-border)', borderRadius: 10, padding: 16,
                fontSize: 12, lineHeight: 1.55, color: 'var(--cr-text)', fontFamily: 'var(--cr-font-mono, monospace)',
                whiteSpace: 'pre-wrap', wordBreak: 'break-word',
            }}>
                {logs || (loading ? 'Loading…' : 'No logs.')}
            </pre>
        </div>
    )
}
