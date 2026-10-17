import { useEffect, useState } from 'react'
import type { CSSProperties } from 'react'
import { getAccount, changePassword, setByok, clearByok, setAccountDefaultModel, clearAccountDefaultModel, getWhatsApp, connectWhatsApp, disconnectWhatsApp, getBusinessContext, setBusinessContext, type AccountInfo } from '../lib/api'
import { socket } from '../lib/socket'
import McpServersCard from './McpPage'
import { useIsMobile } from '../hooks/useIsMobile'
import { useAuthStore } from '../stores/authStore'
import { MODEL_OPTIONS } from '../lib/model-options'
import ConnectedAccounts from '../components/ConnectedAccounts'
import PhoneNotifyCard from '../components/PhoneNotifyCard'
import ThemeToggle from '../components/ThemeToggle'

// Client Account — every logged-in user manages their own profile, password, plan/usage,
// and BYOK key here. (Distinct from the admin/operator System settings.)
/**
 * The card wrapper for ConnectedAccounts.
 *
 * Separate so the heading and border vanish along with the contents outside the desktop
 * app — a card titled "Your browser" sitting empty on the web dashboard would be worse
 * than no card at all.
 */
function DesktopAccountsCard({ card, h2 }: { card: CSSProperties; h2: CSSProperties }) {
    const inApp = typeof window !== 'undefined'
        && Boolean((window as unknown as { nanocrewDesktop?: unknown }).nanocrewDesktop)
    if (!inApp) return null
    return (
        <div style={card}>
            <h2 style={h2}>Your browser</h2>
            <ConnectedAccounts />
        </div>
    )
}

export default function AccountPage() {
    const isMobile = useIsMobile()
    const logout = useAuthStore(s => s.logout)
    const [info, setInfo] = useState<AccountInfo | null>(null)
    const [error, setError] = useState<string | null>(null)

    // password form
    const [pw, setPw] = useState({ cur: '', next: '', confirm: '' })
    const [pwBusy, setPwBusy] = useState(false)
    const [pwMsg, setPwMsg] = useState<{ ok: boolean; text: string } | null>(null)

    // byok form
    const [provider, setProvider] = useState('anthropic')
    const [apiKey, setApiKey] = useState('')
    const [byokModel, setByokModel] = useState('')
    const [byokBusy, setByokBusy] = useState(false)
    const [byokMsg, setByokMsg] = useState<{ ok: boolean; text: string } | null>(null)

    // default model — this owner's fallback for agents that don't have their own override
    const [defaultModel, setDefaultModel] = useState('')
    const [defaultModelBusy, setDefaultModelBusy] = useState(false)
    const [defaultModelMsg, setDefaultModelMsg] = useState<{ ok: boolean; text: string } | null>(null)

    // Business context — one line shared by every agent on the account
    const [bizText, setBizText] = useState('')
    const [bizBusy, setBizBusy] = useState(false)
    const [bizMsg, setBizMsg] = useState<{ ok: boolean; text: string } | null>(null)

    // WhatsApp (Stage 30)
    const [wa, setWa] = useState<{ state: string; number: string | null }>({ state: 'disconnected', number: null })
    const [waQr, setWaQr] = useState<string | null>(null)
    const [waBusy, setWaBusy] = useState(false)

    const load = () => getAccount().then(setInfo).catch(e => setError(e instanceof Error ? e.message : 'Failed to load'))
    useEffect(() => { load() }, [])
    useEffect(() => { if (info) setDefaultModel(info.defaultModel ?? '') }, [info])
    useEffect(() => { getBusinessContext().then(r => setBizText(r.context)).catch(() => { /* leave blank */ }) }, [])

    async function saveBusiness() {
        setBizBusy(true); setBizMsg(null)
        try {
            await setBusinessContext(bizText)
            setBizMsg({ ok: true, text: 'Saved — your crew will use this from their next run.' })
        } catch (e) {
            setBizMsg({ ok: false, text: e instanceof Error ? e.message : 'Failed' })
        } finally { setBizBusy(false) }
    }
    // Deep-link support — the agent Tools tab + the old /system/mcp URL both send users here.
    useEffect(() => {
        if (window.location.hash === '#mcp-servers') {
            setTimeout(() => document.getElementById('mcp-servers')?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 50)
        }
    }, [])

    useEffect(() => {
        getWhatsApp().then(setWa).catch(() => {})
        const onQr = (d: { qr: string }) => setWaQr(d.qr)
        const onState = (d: { state: string; number: string | null }) => { setWa(d); if (d.state === 'connected') setWaQr(null) }
        socket.on('whatsapp:qr', onQr)
        socket.on('whatsapp:state', onState)
        return () => { socket.off('whatsapp:qr', onQr); socket.off('whatsapp:state', onState) }
    }, [])

    async function waConnect() {
        setWaBusy(true); setWaQr(null)
        try { const r = await connectWhatsApp(); setWa({ state: r.state, number: r.number }) }
        catch (e) { setError(e instanceof Error ? e.message : 'Failed') }
        finally { setWaBusy(false) }
    }
    async function waDisconnect() {
        setWaBusy(true)
        try { await disconnectWhatsApp(); setWa({ state: 'disconnected', number: null }); setWaQr(null) }
        catch (e) { setError(e instanceof Error ? e.message : 'Failed') }
        finally { setWaBusy(false) }
    }


    async function submitPassword() {
        setPwMsg(null)
        if (pw.next !== pw.confirm) { setPwMsg({ ok: false, text: 'New passwords do not match.' }); return }
        setPwBusy(true)
        try {
            await changePassword(pw.cur, pw.next)
            setPwMsg({ ok: true, text: 'Password changed.' })
            setPw({ cur: '', next: '', confirm: '' })
        } catch (e) { setPwMsg({ ok: false, text: e instanceof Error ? e.message : 'Failed' }) }
        finally { setPwBusy(false) }
    }

    async function saveByok() {
        setByokMsg(null); setByokBusy(true)
        try {
            await setByok(provider, apiKey, byokModel.trim() || undefined)
            setByokMsg({ ok: true, text: 'Key saved and encrypted.' })
            setApiKey(''); setByokModel(''); load()
        } catch (e) { setByokMsg({ ok: false, text: e instanceof Error ? e.message : 'Failed' }) }
        finally { setByokBusy(false) }
    }
    async function removeByok() {
        setByokBusy(true); setByokMsg(null)
        try { await clearByok(); setByokMsg({ ok: true, text: 'Key removed.' }); load() }
        catch (e) { setByokMsg({ ok: false, text: e instanceof Error ? e.message : 'Failed' }) }
        finally { setByokBusy(false) }
    }

    async function saveDefaultModel() {
        setDefaultModelBusy(true); setDefaultModelMsg(null)
        try {
            if (defaultModel) await setAccountDefaultModel(defaultModel)
            else await clearAccountDefaultModel()
            setDefaultModelMsg({ ok: true, text: defaultModel ? 'Saved.' : 'Cleared — back to the platform default.' })
            load()
        } catch (e) {
            setDefaultModelMsg({ ok: false, text: e instanceof Error ? e.message : 'Failed' })
        } finally { setDefaultModelBusy(false) }
    }

    const card: CSSProperties = { padding: isMobile ? 16 : 22, border: '1px solid var(--cr-border)', borderRadius: 12, background: 'var(--cr-bg-panel)', marginTop: 18 }
    const h2: CSSProperties = { fontSize: 15, fontWeight: 700, color: 'var(--cr-cream)', margin: 0 }
    const input: CSSProperties = { width: '100%', marginTop: 6, padding: '9px 11px', fontSize: 13, borderRadius: 8, border: '1px solid var(--cr-border)', background: 'var(--cr-tint-2)', color: 'var(--cr-cream)', boxSizing: 'border-box' }
    const label: CSSProperties = { display: 'block', marginTop: 12, fontSize: 12, color: 'var(--cr-sub)' }
    const btn = (busy: boolean, disabled = false): CSSProperties => ({ marginTop: 16, padding: '9px 18px', fontSize: 13, fontWeight: 600, borderRadius: 8, border: 'none', background: 'var(--cr-accent)', color: 'var(--cr-on-accent)', cursor: busy || disabled ? 'default' : 'pointer', opacity: busy || disabled ? 0.6 : 1 })
    const msg = (m: { ok: boolean; text: string } | null) => m && <div style={{ marginTop: 10, fontSize: 12.5, color: m.ok ? 'var(--cr-green)' : 'var(--cr-red)' }}>{m.text}</div>

    if (error) return <div style={{ padding: 32, color: 'var(--cr-red)' }}>{error}</div>
    if (!info) return <div style={{ padding: 32, color: 'var(--cr-muted)' }}>Loading…</div>

    const currentPlan = info.user.plan || '' // empty = no active plan → no tier is "current"
    const meters = [
        { label: 'Agent runs (cycles)', used: info.usage.cyclesThisMonth, limit: info.usage.cycleLimit },
        { label: 'Agents', used: info.usage.agentCount, limit: info.usage.agentLimit },
        { label: 'Projects', used: info.usage.projectCount, limit: info.usage.projectLimit },
    ]
    const PLANS = [
        { key: 'standard', name: 'Standard', price: 15, blurb: '200 runs/mo · 5 agents · WhatsApp' },
        { key: 'pro', name: 'Pro', price: 30, blurb: '1,000 runs/mo · 10 agents · BYOK' },
        { key: 'business', name: 'Business', price: 100, blurb: 'Unlimited agents & projects · all channels · priority' },
    ]

    return (
        <div style={{ padding: isMobile ? '18px 14px 32px' : '28px 32px', maxWidth: 760, margin: '0 auto', boxSizing: 'border-box' }}>
            <h1 style={{ fontFamily: 'var(--cr-font-serif, serif)', fontSize: isMobile ? 22 : 26, color: 'var(--cr-cream)', margin: 0 }}>Account</h1>
            <div style={{ fontSize: 13, color: 'var(--cr-muted)', marginTop: 4 }}>Your profile, plan, password, and API key.</div>

            {/* Profile + plan */}
            <div style={card}>
                <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12 }}>
                    <h2 style={h2}>Profile</h2>
                    {/* Log out — moved here from the topbar (2026-08-15), which no longer
                        exists. This is now the one place account identity and signing out
                        both live. */}
                    <button onClick={() => { void logout() }} style={{
                        padding: '6px 12px', fontSize: 12, fontWeight: 600, borderRadius: 7,
                        border: '1px solid var(--cr-border)', background: 'transparent',
                        color: 'var(--cr-muted)', cursor: 'pointer', flexShrink: 0,
                        transition: 'color 0.15s, border-color 0.15s',
                    }}
                        onMouseEnter={e => { e.currentTarget.style.color = 'var(--cr-cream)'; e.currentTarget.style.borderColor = 'var(--cr-border-bright)' }}
                        onMouseLeave={e => { e.currentTarget.style.color = 'var(--cr-muted)'; e.currentTarget.style.borderColor = 'var(--cr-border)' }}
                    >
                        Log out
                    </button>
                </div>
                <div style={{ marginTop: 12, fontSize: 13, color: 'var(--cr-sub)', display: 'grid', gridTemplateColumns: isMobile ? '100px 1fr' : '120px 1fr', columnGap: 8, rowGap: 8 }}>
                    <span style={{ color: 'var(--cr-muted)' }}>Email</span><span>{info.user.email}</span>
                    <span style={{ color: 'var(--cr-muted)' }}>Plan</span>
                    <span><span style={{ padding: '2px 10px', borderRadius: 6, background: 'var(--cr-accent-low)', color: 'var(--cr-accent)', fontSize: 12, textTransform: 'capitalize' }}>{info.user.plan || 'no active plan'}</span></span>
                    <span style={{ color: 'var(--cr-muted)' }}>Member since</span><span>{new Date(info.user.created_at).toLocaleDateString()}</span>
                    {/* Appearance moved here from the sidebar footer (2026-09-06).
                        A theme is chosen once and then forgotten, so it belongs with the
                        other settings rather than taking permanent space in the nav
                        column next to things you click every day. */}
                    <span style={{ color: 'var(--cr-muted)', alignSelf: 'center' }}>Appearance</span>
                    <span><ThemeToggle compact /></span>
                </div>
            </div>

            {/* What the crew knows about the business.
                Editable because this one string is prefixed to every prompt for every
                agent on the account — a stale or wrong description degrades all of
                them at once, and there would otherwise be no way to correct it after
                the answer given at first hire. */}
            <div style={card}>
                <h2 style={h2}>What your crew knows about your business</h2>
                <p style={{ marginTop: 6, marginBottom: 0, fontSize: 12.5, color: 'var(--cr-sub)', lineHeight: 1.5 }}>
                    Every specialist you hire is told this, so you never have to explain it twice.
                </p>
                <textarea
                    value={bizText}
                    onChange={e => setBizText(e.target.value)}
                    rows={3}
                    placeholder="e.g. We run a logistics platform for freight brokers"
                    style={{ ...input, marginTop: 10, resize: 'vertical', lineHeight: 1.5 }}
                />
                <button onClick={saveBusiness} disabled={bizBusy} style={btn(bizBusy)}>
                    {bizBusy ? 'Saving…' : 'Save'}
                </button>
                {msg(bizMsg)}
            </div>

            {/* Sites the agent's browser is signed into (stage 52 Phase 3).
                Renders nothing outside the desktop app — a web page has no browser
                profile to report on — so this card is invisible on the web dashboard. */}
            <DesktopAccountsCard card={card} h2={h2} />

            {/* WhatsApp (Stage 30) */}
            <div style={card}>
                <h2 style={h2}>WhatsApp</h2>
                <div style={{ fontSize: 12.5, color: 'var(--cr-muted)', marginTop: 6, lineHeight: 1.5 }}>
                    Connect your WhatsApp, then <b>@-mention your agents</b> in any chat — e.g. <code>@tracker log my run</code> — and they reply. Replies come from your own number.
                </div>
                {wa.state === 'connected' ? (
                    <div style={{ marginTop: 14, display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
                        <span style={{ fontSize: 13, color: 'var(--cr-sub)' }}>✅ Connected{wa.number ? <> as <b style={{ color: 'var(--cr-cream)' }}>+{wa.number}</b></> : null}</span>
                        <button onClick={waDisconnect} disabled={waBusy} style={{ padding: '6px 12px', fontSize: 12, borderRadius: 7, border: '1px solid var(--cr-border)', background: 'transparent', color: 'var(--cr-error)', cursor: 'pointer' }}>Disconnect</button>
                    </div>
                ) : waQr ? (
                    <div style={{ marginTop: 14, display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap' }}>
                        {/* Quiet zone must stay white in both themes — phone cameras
                            fail to read a QR code on a tinted background. */}
                        <img src={waQr} alt="WhatsApp QR" width={180} height={180} style={{ borderRadius: 10, background: '#fff', padding: 6 }} />
                        <div style={{ fontSize: 12.5, color: 'var(--cr-sub)', maxWidth: 260, lineHeight: 1.5 }}>
                            On your phone: WhatsApp → <b>Settings → Linked Devices → Link a Device</b> → scan this code.
                        </div>
                    </div>
                ) : (wa.state === 'connecting' || wa.state === 'qr') ? (
                    <div style={{ marginTop: 14, fontSize: 13, color: 'var(--cr-muted)' }}>Starting… a QR code will appear shortly.</div>
                ) : (
                    <button onClick={waConnect} disabled={waBusy} style={btn(waBusy)}>{waBusy ? 'Starting…' : 'Connect WhatsApp'}</button>
                )}
            </div>

            {/* Approvals and questions on the phone (stage 64 phase 1) */}
            <PhoneNotifyCard card={card} h2={h2} btn={b => btn(b)} waState={wa.state} />

            {/* Usage */}
            <div style={card}>
                <h2 style={h2}>Usage this month</h2>
                <div style={{ marginTop: 14 }}>
                    {meters.map(m => {
                        const unlimited = m.limit == null
                        const p = m.limit != null && m.limit > 0 ? Math.min(100, Math.round((m.used / m.limit) * 100)) : 0
                        return (
                            <div key={m.label} style={{ marginBottom: 14 }}>
                                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, color: 'var(--cr-sub)' }}>
                                    <span>{m.label}</span>
                                    <span><b style={{ color: 'var(--cr-cream)', fontFamily: 'var(--cr-font-mono,monospace)' }}>{m.used}</b> / {unlimited ? '∞' : m.limit}</span>
                                </div>
                                <div style={{ marginTop: 6, height: 8, borderRadius: 999, background: 'var(--cr-tint-4)', overflow: 'hidden' }}>
                                    <div style={{ height: '100%', width: `${unlimited ? 0 : p}%`, background: p >= 90 ? 'var(--cr-red)' : 'var(--cr-accent)', transition: 'width .3s' }} />
                                </div>
                            </div>
                        )
                    })}
                </div>
                <div style={{ fontSize: 11, color: 'var(--cr-muted)' }}>Agent runs reset on the 1st of each month. We’ll remind you at 50%, 75%, 90% and 100% of your runs.</div>
            </div>

            {/* Change password */}
            <div style={card}>
                <h2 style={h2}>Change password</h2>
                <label style={label}>Current password<input type="password" value={pw.cur} onChange={e => setPw(s => ({ ...s, cur: e.target.value }))} style={input} /></label>
                <label style={label}>New password<input type="password" value={pw.next} onChange={e => setPw(s => ({ ...s, next: e.target.value }))} style={input} /></label>
                <label style={label}>Confirm new password<input type="password" value={pw.confirm} onChange={e => setPw(s => ({ ...s, confirm: e.target.value }))} style={input} /></label>
                {msg(pwMsg)}
                <button onClick={submitPassword} disabled={pwBusy || !pw.cur || !pw.next} style={btn(pwBusy, !pw.cur || !pw.next)}>{pwBusy ? 'Saving…' : 'Update password'}</button>
            </div>

            {/* Default model */}
            <div style={card}>
                <h2 style={h2}>Default model for your agents</h2>
                <div style={{ fontSize: 12.5, color: 'var(--cr-muted)', marginTop: 6, lineHeight: 1.5 }}>
                    Applies to any of your agents that don't have their own model set (Agent Profile →
                    Manage → Models). A specific agent's own choice always wins over this.
                </div>
                <label style={label}>Model
                    <select value={defaultModel} onChange={e => setDefaultModel(e.target.value)} style={{ ...input, colorScheme: 'dark' }}>
                        <option value="" style={{ background: 'var(--cr-bg-elevated)', color: 'var(--cr-cream)' }}>Inherit platform default</option>
                        {MODEL_OPTIONS.map(o => (
                            <option key={o.value} value={o.value} style={{ background: 'var(--cr-bg-elevated)', color: 'var(--cr-cream)' }}>{o.label} — {o.price}</option>
                        ))}
                    </select>
                </label>
                {msg(defaultModelMsg)}
                <button onClick={saveDefaultModel} disabled={defaultModelBusy} style={btn(defaultModelBusy)}>{defaultModelBusy ? 'Saving…' : 'Save default'}</button>
            </div>

            {/* BYOK */}
            <div style={card}>
                <h2 style={h2}>Bring your own API key (BYOK)</h2>
                <div style={{ fontSize: 12.5, color: 'var(--cr-muted)', marginTop: 6, lineHeight: 1.5 }}>
                    On Pro &amp; Business, connect your own provider key to run any model on your own account. Your key is encrypted at rest.
                </div>
                {!info.byokAllowed ? (
                    <div style={{ marginTop: 14, padding: '10px 12px', borderRadius: 8, border: '1px dashed var(--cr-border)', fontSize: 12.5, color: 'var(--cr-muted)' }}>
                        🔒 Bring your own key is available on the <b style={{ color: 'var(--cr-sub)' }}>Pro</b> &amp; <b style={{ color: 'var(--cr-sub)' }}>Business</b> plans. Choose one above to enable it.
                    </div>
                ) : info.byok.hasKey ? (
                    <div style={{ marginTop: 14, display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
                        <span style={{ fontSize: 13, color: 'var(--cr-sub)' }}>✅ Key set for <b style={{ color: 'var(--cr-cream)', textTransform: 'capitalize' }}>{info.byok.provider}</b>{info.byok.model && <span style={{ color: 'var(--cr-muted)' }}> · model <code style={{ fontSize: 12 }}>{info.byok.model}</code></span>}</span>
                        <button onClick={removeByok} disabled={byokBusy} style={{ padding: '6px 12px', fontSize: 12, borderRadius: 7, border: '1px solid var(--cr-border)', background: 'transparent', color: 'var(--cr-error)', cursor: 'pointer' }}>Remove</button>
                    </div>
                ) : (
                    <>
                        <label style={label}>Provider
                            <select value={provider} onChange={e => setProvider(e.target.value)} style={{ ...input, colorScheme: 'dark' }}>
                                {info.byokProviders.map(p => <option key={p} value={p} style={{ background: 'var(--cr-bg-elevated)', color: 'var(--cr-cream)' }}>{p}</option>)}
                            </select>
                        </label>
                        <label style={label}>API key<input type="password" value={apiKey} onChange={e => setApiKey(e.target.value)} placeholder="sk-…" style={input} /></label>
                        <label style={label}>Model <span style={{ color: 'var(--cr-muted)' }}>(optional — defaults to a sensible model for the provider)</span>
                            <input value={byokModel} onChange={e => setByokModel(e.target.value)} placeholder="e.g. anthropic/claude-sonnet-4-6" style={input} /></label>
                        <button onClick={saveByok} disabled={byokBusy || apiKey.trim().length < 10} style={btn(byokBusy, apiKey.trim().length < 10)}>{byokBusy ? 'Saving…' : 'Save key'}</button>
                    </>
                )}
                {msg(byokMsg)}
            </div>

            {/* MCP Servers */}
            <div id="mcp-servers" style={card}>
                <h2 style={h2}>MCP Servers</h2>
                <div style={{ fontSize: 12.5, color: 'var(--cr-muted)', marginTop: 6, marginBottom: 4, lineHeight: 1.5 }}>
                    External tool servers via Model Context Protocol — connect a server once and it's available to all your agents.
                </div>
                <McpServersCard />
            </div>
        </div>
    )
}
