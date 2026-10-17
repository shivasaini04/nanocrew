import { useEffect, useState, type CSSProperties } from 'react'
import { useNavigate } from 'react-router-dom'
import { getAdminStats, getAdminClients, createAdminClient, type AdminClient } from '../lib/api'

export default function AdminPage() {
    const navigate = useNavigate()
    const [stats, setStats] = useState<{ totalClients: number; activeThisMonth: number; totalCycles: number; totalCost: number } | null>(null)
    const [clients, setClients] = useState<AdminClient[]>([])
    const [error, setError] = useState<string | null>(null)

    // Create-client modal (invite-only onboarding)
    const [showCreate, setShowCreate] = useState(false)
    const [form, setForm] = useState({ email: '', password: '', plan: '' })
    const [creating, setCreating] = useState(false)
    const [createErr, setCreateErr] = useState<string | null>(null)
    const [createdCreds, setCreatedCreds] = useState<{ email: string; password: string } | null>(null)

    useEffect(() => {
        Promise.all([getAdminStats(), getAdminClients()])
            .then(([s, c]) => { setStats(s); setClients(c.clients) })
            .catch(e => setError(e instanceof Error ? e.message : 'Failed to load'))
    }, [])

    const fmtDate = (s: string | null) => s ? new Date(s).toLocaleDateString() : '—'

    async function handleCreate() {
        setCreating(true); setCreateErr(null)
        try {
            const res = await createAdminClient({
                email: form.email.trim(),
                password: form.password.trim() || undefined,
                plan: form.plan.trim() || undefined,
            })
            const c = await getAdminClients(); setClients(c.clients)
            setCreatedCreds({ email: form.email.trim(), password: res.tempPassword || form.password.trim() })
            setForm({ email: '', password: '', plan: '' })
            setShowCreate(false)
        } catch (err) {
            setCreateErr(err instanceof Error ? err.message : 'Failed to create')
        } finally {
            setCreating(false)
        }
    }

    const inputStyle: CSSProperties = {
        width: '100%', marginTop: 6, padding: '8px 10px', fontSize: 13, borderRadius: 7,
        border: '1px solid var(--cr-border)', background: 'var(--cr-tint-2)',
        color: 'var(--cr-cream)', boxSizing: 'border-box',
    }

    return (
        <div style={{ padding: '28px 32px', maxWidth: 1100, margin: '0 auto' }}>
            <h1 style={{ fontFamily: 'var(--cr-font-serif, serif)', fontSize: 26, color: 'var(--cr-cream)', margin: 0 }}>Admin Panel</h1>
            <div style={{ fontSize: 13, color: 'var(--cr-muted)', marginTop: 4 }}>Platform overview and client accounts</div>

            {error && <div style={{ marginTop: 16, color: 'var(--cr-red)', fontSize: 13 }}>{error}</div>}

            {/* Stats */}
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 14, marginTop: 24 }}>
                {[
                    { label: 'Clients', value: stats?.totalClients ?? '—' },
                    { label: 'Active this month', value: stats?.activeThisMonth ?? '—' },
                    { label: 'Total cycles', value: stats?.totalCycles ?? '—' },
                    { label: 'Total spent', value: stats ? `$${stats.totalCost.toFixed(2)}` : '—' },
                ].map(({ label, value }) => (
                    <div key={label} style={{ padding: 18, border: '1px solid var(--cr-border)', borderRadius: 10, background: 'var(--cr-bg-panel)' }}>
                        <div style={{ fontSize: 11, color: 'var(--cr-muted)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>{label}</div>
                        <div style={{ fontSize: 26, fontWeight: 700, color: 'var(--cr-cream)', marginTop: 6, fontFamily: 'var(--cr-font-mono, monospace)' }}>{value}</div>
                    </div>
                ))}
            </div>

            {/* Newly-created credentials banner (shown once) */}
            {createdCreds && (
                <div style={{ marginTop: 20, padding: 16, border: '1px solid var(--cr-green-line)', borderRadius: 10, background: 'var(--cr-green-low)' }}>
                    <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--cr-green)' }}>Account created — share these credentials</div>
                    <div style={{ marginTop: 8, fontFamily: 'var(--cr-font-mono, monospace)', fontSize: 13, color: 'var(--cr-cream)' }}>
                        <div>email: {createdCreds.email}</div>
                        <div>password: {createdCreds.password}</div>
                    </div>
                    <div style={{ marginTop: 8, fontSize: 11, color: 'var(--cr-muted)' }}>Won't be shown again. The client can change it after logging in.</div>
                    <button onClick={() => setCreatedCreds(null)} style={{ marginTop: 10, padding: '5px 12px', fontSize: 12, borderRadius: 6, border: '1px solid var(--cr-border)', background: 'transparent', color: 'var(--cr-sub)', cursor: 'pointer' }}>Dismiss</button>
                </div>
            )}

            {/* Client list */}
            <div style={{ marginTop: 32 }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
                    <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--cr-sub)' }}>Clients</div>
                    <button onClick={() => { setShowCreate(true); setCreateErr(null) }}
                        style={{ padding: '7px 14px', fontSize: 12, fontWeight: 600, borderRadius: 7, border: '1px solid var(--cr-border)', background: 'var(--cr-accent)', color: 'var(--cr-on-accent)', cursor: 'pointer' }}>
                        + New client
                    </button>
                </div>
                <div style={{ border: '1px solid var(--cr-border)', borderRadius: 10, overflow: 'hidden' }}>
                    <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                        <thead>
                            <tr style={{ background: 'var(--cr-tint-2)', color: 'var(--cr-muted)', textAlign: 'left' }}>
                                {['Email', 'Plan', 'Status', 'Agents', 'Cycles', 'Spent', 'Last active'].map(h => (
                                    <th key={h} style={{ padding: '10px 14px', fontWeight: 600, fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.04em' }}>{h}</th>
                                ))}
                            </tr>
                        </thead>
                        <tbody>
                            {clients.map(c => (
                                <tr key={c.id}
                                    onClick={() => navigate(`/admin/clients/${c.id}`)}
                                    style={{ borderTop: '1px solid var(--cr-border)', cursor: 'pointer', color: 'var(--cr-cream)' }}
                                    onMouseEnter={e => e.currentTarget.style.background = 'var(--cr-tint-2)'}
                                    onMouseLeave={e => e.currentTarget.style.background = 'transparent'}>
                                    <td style={{ padding: '10px 14px' }}>
                                        {c.email}{c.role === 'admin' && <span style={{ marginLeft: 6, fontSize: 10, color: 'var(--cr-blue)' }}>admin</span>}
                                    </td>
                                    <td style={{ padding: '10px 14px', color: 'var(--cr-muted)' }}>{c.plan ?? '—'}</td>
                                    <td style={{ padding: '10px 14px' }}>
                                        <span style={{ fontSize: 11, padding: '2px 8px', borderRadius: 6, background: c.status === 'active' ? 'var(--cr-green-low)' : 'var(--cr-red-low)', color: c.status === 'active' ? 'var(--cr-green)' : 'var(--cr-red)' }}>{c.status}</span>
                                    </td>
                                    <td style={{ padding: '10px 14px' }}>{c.agent_count}</td>
                                    <td style={{ padding: '10px 14px' }}>{c.cycle_count}</td>
                                    <td style={{ padding: '10px 14px' }}>${Number(c.cost).toFixed(2)}</td>
                                    <td style={{ padding: '10px 14px', color: 'var(--cr-muted)' }}>{fmtDate(c.last_active)}</td>
                                </tr>
                            ))}
                            {clients.length === 0 && !error && (
                                <tr><td colSpan={7} style={{ padding: 18, color: 'var(--cr-muted)', textAlign: 'center' }}>No clients yet.</td></tr>
                            )}
                        </tbody>
                    </table>
                </div>
            </div>

            {/* Create-client modal (invite-only onboarding) */}
            {showCreate && (
                <div onClick={() => !creating && setShowCreate(false)}
                    style={{ position: 'fixed', inset: 0, background: 'var(--cr-scrim)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 50 }}>
                    <form onClick={e => e.stopPropagation()} onSubmit={e => { e.preventDefault(); handleCreate() }}
                        style={{ width: 380, padding: 22, borderRadius: 12, border: '1px solid var(--cr-border)', background: 'var(--cr-bg-panel)' }}>
                        <div style={{ fontSize: 16, fontWeight: 700, color: 'var(--cr-cream)' }}>New client account</div>
                        <div style={{ fontSize: 12, color: 'var(--cr-muted)', marginTop: 4 }}>Creates the account and its Recruiter. Leave the password blank to auto-generate one.</div>
                        {createErr && <div style={{ marginTop: 10, fontSize: 12, color: 'var(--cr-red)' }}>{createErr}</div>}
                        <label style={{ display: 'block', marginTop: 14, fontSize: 12, color: 'var(--cr-sub)' }}>Email
                            <input type="email" required autoFocus value={form.email} onChange={e => setForm(f => ({ ...f, email: e.target.value }))} style={inputStyle} />
                        </label>
                        <label style={{ display: 'block', marginTop: 12, fontSize: 12, color: 'var(--cr-sub)' }}>Password <span style={{ color: 'var(--cr-muted)' }}>(optional)</span>
                            <input type="text" value={form.password} onChange={e => setForm(f => ({ ...f, password: e.target.value }))} placeholder="auto-generate if blank" style={inputStyle} />
                        </label>
                        <label style={{ display: 'block', marginTop: 12, fontSize: 12, color: 'var(--cr-sub)' }}>Plan <span style={{ color: 'var(--cr-muted)' }}>(optional)</span>
                            <select value={form.plan} onChange={e => setForm(f => ({ ...f, plan: e.target.value }))} style={inputStyle}>
                                <option value="">— none —</option>
                                <option value="standard">Standard</option>
                                <option value="pro">Pro</option>
                                <option value="business">Business</option>
                            </select>
                        </label>
                        <div style={{ display: 'flex', gap: 10, marginTop: 20, justifyContent: 'flex-end' }}>
                            <button type="button" disabled={creating} onClick={() => setShowCreate(false)}
                                style={{ padding: '8px 14px', fontSize: 13, borderRadius: 7, border: '1px solid var(--cr-border)', background: 'transparent', color: 'var(--cr-sub)', cursor: 'pointer' }}>Cancel</button>
                            <button type="submit" disabled={creating || !form.email.trim()}
                                style={{ padding: '8px 16px', fontSize: 13, fontWeight: 600, borderRadius: 7, border: 'none', background: 'var(--cr-accent)', color: 'var(--cr-on-accent)', cursor: creating ? 'default' : 'pointer', opacity: creating || !form.email.trim() ? 0.6 : 1 }}>
                                {creating ? 'Creating…' : 'Create account'}
                            </button>
                        </div>
                    </form>
                </div>
            )}
        </div>
    )
}
