import { useEffect, useState } from 'react'
import type { CSSProperties } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { getAdminClient, updateAdminClient, deleteAdminClient, resetClientPassword, type AdminClient } from '../lib/api'
import { useAuthStore } from '../stores/authStore'

type AgentRow = { id: string; name: string; emoji: string | null; status: string; cycles: number; cost: number; last_active: string | null }

export default function AdminClientDetailPage() {
    const { id = '' } = useParams()
    const navigate = useNavigate()
    const [user, setUser] = useState<AdminClient | null>(null)
    const [agents, setAgents] = useState<AgentRow[]>([])
    const [error, setError] = useState<string | null>(null)
    const [busy, setBusy] = useState(false)
    const [planDraft, setPlanDraft] = useState('')
    const [confirmDelete, setConfirmDelete] = useState(false)
    const [newPw, setNewPw] = useState<string | null>(null)
    const startImpersonation = useAuthStore(s => s.startImpersonation)

    const load = () => getAdminClient(id)
        .then(d => { setUser(d.user); setAgents(d.agents); setPlanDraft(d.user.plan ?? '') })
        .catch(e => setError(e instanceof Error ? e.message : 'Failed to load'))

    useEffect(() => { load() }, [id])

    const act = async (fn: () => Promise<unknown>) => {
        setError(null); setBusy(true)
        try { await fn(); await load() }
        catch (e) { setError(e instanceof Error ? e.message : 'Action failed') }
        finally { setBusy(false) }
    }

    const resetPw = async () => {
        setError(null); setBusy(true); setNewPw(null)
        try { const r = await resetClientPassword(id); setNewPw(r.password ?? '(updated)') }
        catch (e) { setError(e instanceof Error ? e.message : 'Action failed') }
        finally { setBusy(false) }
    }

    if (!user) return <div style={{ padding: 32, color: 'var(--cr-muted)' }}>{error || 'Loading…'}</div>

    const isAdminAccount = user.role === 'admin'

    return (
        <div style={{ padding: '28px 32px', maxWidth: 900, margin: '0 auto' }}>
            <button onClick={() => navigate('/admin')} style={{ background: 'none', border: 'none', color: 'var(--cr-muted)', cursor: 'pointer', fontSize: 12, marginBottom: 16 }}>← Back to Admin</button>

            <h1 style={{ fontFamily: 'var(--cr-font-serif, serif)', fontSize: 24, color: 'var(--cr-cream)', margin: 0 }}>{user.email}</h1>
            <div style={{ fontSize: 12, color: 'var(--cr-muted)', marginTop: 4 }}>
                {user.role} · joined {new Date(user.created_at).toLocaleDateString()} · last active {user.last_active ? new Date(user.last_active).toLocaleString() : '—'}
            </div>

            {error && <div style={{ marginTop: 14, color: 'var(--cr-red)', fontSize: 13 }}>{error}</div>}

            {/* Stats */}
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12, marginTop: 22 }}>
                {[
                    { label: 'Status', value: user.status },
                    { label: 'Agents', value: user.agent_count },
                    { label: 'Cycles', value: user.cycle_count },
                    { label: 'Spent', value: `$${Number(user.cost).toFixed(2)}` },
                ].map(({ label, value }) => (
                    <div key={label} style={{ padding: 14, border: '1px solid var(--cr-border)', borderRadius: 10 }}>
                        <div style={{ fontSize: 10, color: 'var(--cr-muted)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>{label}</div>
                        <div style={{ fontSize: 18, fontWeight: 700, color: 'var(--cr-cream)', marginTop: 4, fontFamily: 'var(--cr-font-mono, monospace)' }}>{value}</div>
                    </div>
                ))}
            </div>

            {/* Account management */}
            {!isAdminAccount && (
                <div style={{ marginTop: 28, padding: 18, border: '1px solid var(--cr-border)', borderRadius: 10 }}>
                    <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--cr-sub)', marginBottom: 14 }}>Manage account</div>

                    {/* View as client (support) */}
                    <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 14 }}>
                        <span style={{ fontSize: 12, color: 'var(--cr-muted)', width: 90 }}>Support</span>
                        <button disabled={busy} onClick={() => act(() => startImpersonation(id))} style={btn('var(--cr-purple)')}>View as client</button>
                        <span style={{ fontSize: 11, color: 'var(--cr-muted)' }}>Opens their dashboard exactly as they see it.</span>
                    </div>

                    {/* Plan */}
                    <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 14 }}>
                        <span style={{ fontSize: 12, color: 'var(--cr-muted)', width: 90 }}>Plan</span>
                        <select value={planDraft} onChange={e => setPlanDraft(e.target.value)}
                            style={{ padding: '7px 10px', borderRadius: 8, border: '1px solid var(--cr-border)', background: 'var(--cr-well-str)', color: 'var(--cr-cream)', fontSize: 13 }}>
                            <option value="">— none —</option>
                            <option value="standard">Standard</option>
                            <option value="pro">Pro</option>
                            <option value="business">Business</option>
                        </select>
                        <button disabled={busy} onClick={() => act(() => updateAdminClient(id, { plan: planDraft.trim() || null }))}
                            style={btn('var(--cr-blue)')}>Save plan</button>
                    </div>

                    {/* Suspend / activate */}
                    <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 14 }}>
                        <span style={{ fontSize: 12, color: 'var(--cr-muted)', width: 90 }}>Access</span>
                        {user.status === 'active' ? (
                            <button disabled={busy} onClick={() => act(() => updateAdminClient(id, { status: 'suspended' }))} style={btn('var(--cr-amber)')}>Suspend account</button>
                        ) : (
                            <button disabled={busy} onClick={() => act(() => updateAdminClient(id, { status: 'active' }))} style={btn('var(--cr-green)')}>Reactivate account</button>
                        )}
                        <span style={{ fontSize: 11, color: 'var(--cr-muted)' }}>{user.status === 'active' ? 'Suspending logs them out and blocks login.' : 'Currently suspended.'}</span>
                    </div>

                    {/* Reset password (support) */}
                    <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 14, flexWrap: 'wrap' }}>
                        <span style={{ fontSize: 12, color: 'var(--cr-muted)', width: 90 }}>Password</span>
                        <button disabled={busy} onClick={resetPw} style={btn('var(--cr-cyan)')}>Reset password</button>
                        {newPw ? (
                            <span style={{ fontSize: 12, color: 'var(--cr-sub)' }}>New password: <code style={{ color: 'var(--cr-green)', fontSize: 13 }}>{newPw}</code> — share it with the client (won't show again).</span>
                        ) : (
                            <span style={{ fontSize: 11, color: 'var(--cr-muted)' }}>Generates a new temp password to give the client.</span>
                        )}
                    </div>

                    {/* Delete */}
                    <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 18, paddingTop: 14, borderTop: '1px solid var(--cr-red-line)' }}>
                        <span style={{ fontSize: 12, color: 'var(--cr-error)', width: 90 }}>Danger</span>
                        {!confirmDelete ? (
                            <button onClick={() => setConfirmDelete(true)} style={btn('var(--cr-error-str)', true)}>Delete account…</button>
                        ) : (
                            <>
                                <span style={{ fontSize: 12, color: 'var(--cr-sub)' }}>Permanently delete {user.email} and all their data?</span>
                                <button disabled={busy} onClick={() => act(async () => { await deleteAdminClient(id); navigate('/admin') })} style={btn('var(--cr-error-str)')}>Yes, delete</button>
                                <button onClick={() => setConfirmDelete(false)} style={btn('transparent', true)}>Cancel</button>
                            </>
                        )}
                    </div>
                </div>
            )}

            {/* Agents */}
            <div style={{ marginTop: 28 }}>
                <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--cr-sub)', marginBottom: 12 }}>Agents ({agents.length})</div>
                <div style={{ border: '1px solid var(--cr-border)', borderRadius: 10, overflow: 'hidden' }}>
                    <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                        <thead>
                            <tr style={{ background: 'var(--cr-tint-2)', color: 'var(--cr-muted)', textAlign: 'left' }}>
                                {['Agent', 'Status', 'Cycles', 'Spent'].map(h => <th key={h} style={{ padding: '9px 14px', fontSize: 11, fontWeight: 600, textTransform: 'uppercase' }}>{h}</th>)}
                            </tr>
                        </thead>
                        <tbody>
                            {agents.map(a => (
                                <tr key={a.id} style={{ borderTop: '1px solid var(--cr-border)', color: 'var(--cr-cream)' }}>
                                    <td style={{ padding: '9px 14px' }}>{a.emoji ?? '🤖'} {a.name}</td>
                                    <td style={{ padding: '9px 14px', color: 'var(--cr-muted)' }}>{a.status}</td>
                                    <td style={{ padding: '9px 14px' }}>{a.cycles}</td>
                                    <td style={{ padding: '9px 14px' }}>${Number(a.cost).toFixed(2)}</td>
                                </tr>
                            ))}
                            {agents.length === 0 && <tr><td colSpan={4} style={{ padding: 16, color: 'var(--cr-muted)', textAlign: 'center' }}>No agents.</td></tr>}
                        </tbody>
                    </table>
                </div>
            </div>
        </div>
    )
}

function btn(color: string, outline = false): CSSProperties {
    return {
        padding: '7px 12px', borderRadius: 8, fontSize: 12, fontWeight: 600, cursor: 'pointer',
        border: outline ? `1px solid ${color === 'transparent' ? 'var(--cr-border)' : color}` : 'none',
        background: outline ? 'transparent' : color,
        color: outline ? (color === 'transparent' ? 'var(--cr-sub)' : color) : 'var(--cr-on-accent)',
    }
}
