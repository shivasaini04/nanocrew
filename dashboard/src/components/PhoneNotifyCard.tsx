import { useEffect, useState, type CSSProperties } from 'react'
import { getNotifySettings, setNotifySettings, sendNotifyTest, linkTelegram, unlinkTelegram, type NotifyPrefs, type NotifyDelivery, type TelegramStatus, type TelegramLink } from '../lib/api'

/**
 * Stage 64 phase 1 — approvals and questions on the owner's phone.
 *
 * Approvals waited a median of 19 hours when the dashboard was the only place to answer.
 * This card turns delivery on, sets the number it goes to, quiet hours, and shows — in
 * plain words — whether the message will actually ring (a separate notifier number) or sit
 * silently in "Message yourself" (the owner's own WhatsApp writing to itself).
 */
export default function PhoneNotifyCard({ card, h2, btn, waState }: {
    card: CSSProperties
    h2: CSSProperties
    btn: (busy: boolean) => CSSProperties
    /** Re-read the route when the owner's own WhatsApp connects or disconnects. */
    waState: string
}) {
    const [prefs, setPrefs] = useState<NotifyPrefs | null>(null)
    const [delivery, setDelivery] = useState<NotifyDelivery | null>(null)
    const [telegram, setTelegram] = useState<TelegramStatus | null>(null)
    // The code on screen while the owner sends it to the bot.
    const [link, setLink] = useState<(TelegramLink & { until: number }) | null>(null)
    const [phone, setPhone] = useState('')
    const [busy, setBusy] = useState(false)
    const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)

    useEffect(() => {
        getNotifySettings().then(r => {
            setPrefs(r.prefs); setDelivery(r.delivery); setTelegram(r.telegram); setPhone(r.prefs.phone ?? '')
        }).catch(() => { /* card stays in its loading state */ })
    }, [waState])

    // While the owner sends the code, watch for the link to land, for as long as the code lives.
    useEffect(() => {
        if (!link) return
        const t = setInterval(async () => {
            if (Date.now() > link.until) {
                setLink(null)
                setMsg({ ok: false, text: 'That code expired. Press Connect Telegram for a new one.' })
                return
            }
            try {
                const r = await getNotifySettings()
                if (r.telegram.linked) {
                    setPrefs(r.prefs); setDelivery(r.delivery); setTelegram(r.telegram)
                    setLink(null)
                    setMsg({ ok: true, text: 'Telegram connected. Approvals will arrive there.' })
                }
            } catch { /* keep waiting */ }
        }, 3000)
        return () => clearInterval(t)
    }, [link])

    // No window.open: on a computer without the Telegram app, the t.me page's Start button does
    // nothing (2026-10-01). The code on screen works everywhere; the link is offered alongside.
    async function connectTelegram() {
        setBusy(true); setMsg(null)
        try {
            const l = await linkTelegram()
            setLink({ ...l, until: Date.now() + l.expiresInMin * 60_000 })
        } catch (e) {
            setMsg({ ok: false, text: e instanceof Error ? e.message : 'Failed' })
        } finally { setBusy(false) }
    }

    async function disconnectTelegram() {
        setBusy(true); setMsg(null)
        try {
            const r = await unlinkTelegram()
            setDelivery(r.delivery); setTelegram(r.telegram)
            setMsg({ ok: true, text: 'Telegram disconnected.' })
        } catch (e) {
            setMsg({ ok: false, text: e instanceof Error ? e.message : 'Failed' })
        } finally { setBusy(false) }
    }

    async function save(patch: Partial<NotifyPrefs>, okText = 'Saved.') {
        setBusy(true); setMsg(null)
        try {
            const r = await setNotifySettings(patch)
            setPrefs(r.prefs); setDelivery(r.delivery); setTelegram(r.telegram); setPhone(r.prefs.phone ?? '')
            setMsg({ ok: true, text: okText })
        } catch (e) {
            setMsg({ ok: false, text: e instanceof Error ? e.message : 'Failed' })
        } finally { setBusy(false) }
    }

    async function test() {
        setBusy(true); setMsg(null)
        try {
            const r = await sendNotifyTest()
            setDelivery(r.delivery)
            setMsg({ ok: true, text: 'Sent — check your phone.' })
        } catch (e) {
            setMsg({ ok: false, text: e instanceof Error ? e.message : 'Failed' })
        } finally { setBusy(false) }
    }

    if (!prefs || !delivery) return null

    const input: CSSProperties = {
        padding: '7px 10px', fontSize: 13, borderRadius: 7, border: '1px solid var(--cr-border)',
        background: 'var(--cr-bg)', color: 'var(--cr-cream)',
    }
    const route =
        delivery.mode === 'telegram'
            ? <>✅ Messages come from your Telegram bot{telegram?.botUsername ? <> <b>@{telegram.botUsername}</b></> : null} — your phone will ring, and you answer with one tap.</>
        : delivery.mode === 'contact'
            ? <>✅ Messages come from <b>+{delivery.from}</b> to <b>+{delivery.to}</b> — your phone will ring.</>
            : delivery.mode === 'self'
                ? <>⚠️ Messages go to your own <b>“Message yourself”</b> chat on +{delivery.to}. WhatsApp doesn’t ring for messages you send yourself, so you’ll only see them when you open that chat. For a ringing notification, enter your phone number below — it needs a separate notifier number linked by the admin.</>
                : <>Not set up yet — connect WhatsApp above, or enter your phone number below.</>

    return (
        <div style={card}>
            <h2 style={h2}>Phone notifications</h2>
            <div style={{ fontSize: 12.5, color: 'var(--cr-muted)', marginTop: 6, lineHeight: 1.5 }}>
                When an agent needs your approval or asks a question, it comes to your phone — Telegram if you connect it, otherwise WhatsApp.
                Tap a button (Telegram), or reply <b>1</b> to approve, <b>2</b> to reject, or write what to change.
            </div>

            <label style={{ marginTop: 14, display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: 'var(--cr-sub)', cursor: 'pointer' }}>
                <input type="checkbox" checked={prefs.whatsapp} disabled={busy}
                    onChange={e => save({ whatsapp: e.target.checked }, e.target.checked ? 'On.' : 'Off — approvals stay on the dashboard.')} />
                Send approvals and questions to my phone
            </label>

            {prefs.whatsapp && telegram?.available && (
                <div style={{ marginTop: 14, padding: '10px 12px', border: '1px solid var(--cr-border)', borderRadius: 8, display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                    <span style={{ fontSize: 13, color: 'var(--cr-sub)', flex: 1, minWidth: 200 }}>
                        {telegram.linked
                            ? <>✅ <b>Telegram connected.</b> It rings, and you answer with one tap.</>
                            : <><b>Telegram</b> — rings like a normal chat and you answer with one tap. No second number needed.</>}
                    </span>
                    {telegram.linked
                        ? <button onClick={disconnectTelegram} disabled={busy}
                            style={{ padding: '6px 12px', fontSize: 12, borderRadius: 7, border: '1px solid var(--cr-border)', background: 'transparent', color: 'var(--cr-error)', cursor: 'pointer' }}>Disconnect</button>
                        : !link && <button onClick={connectTelegram} disabled={busy} style={{ ...btn(busy), marginTop: 0 }}>
                            Connect Telegram
                        </button>}
                    {link && !telegram.linked && (
                        <div style={{ flexBasis: '100%', fontSize: 13, color: 'var(--cr-sub)', lineHeight: 1.6 }}>
                            In Telegram on your phone, search <b>@{link.botUsername}</b>, open the chat, and send this code:
                            <div style={{ display: 'flex', alignItems: 'center', gap: 10, margin: '8px 0', flexWrap: 'wrap' }}>
                                <code style={{ fontSize: 22, letterSpacing: 3, fontWeight: 700, padding: '4px 12px', borderRadius: 7, border: '1px solid var(--cr-border)', background: 'var(--cr-bg)', color: 'var(--cr-cream)', userSelect: 'all' }}>
                                    {link.code.slice(0, 4)} {link.code.slice(4)}
                                </code>
                                <button onClick={() => { void navigator.clipboard?.writeText(link.code).then(() => setMsg({ ok: true, text: 'Code copied.' })) }}
                                    style={{ padding: '5px 10px', fontSize: 12, borderRadius: 7, border: '1px solid var(--cr-border)', background: 'transparent', color: 'var(--cr-sub)', cursor: 'pointer' }}>Copy</button>
                                <a href={link.url} target="_blank" rel="noopener noreferrer" style={{ fontSize: 12.5 }}>Telegram app on this device? Open the chat</a>
                            </div>
                            <span style={{ fontSize: 12, color: 'var(--cr-muted)' }}>
                                If the bot shows a Start button, tap it first. The code works once, for {link.expiresInMin} minutes. This card updates when you’re connected.
                            </span>
                        </div>
                    )}
                </div>
            )}

            {prefs.whatsapp && (
                <>
                    <div style={{ marginTop: 12, fontSize: 12.5, color: 'var(--cr-sub)', lineHeight: 1.5 }}>{route}</div>

                    <div style={{ marginTop: 14, display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                        <span style={{ fontSize: 12.5, color: 'var(--cr-muted)', minWidth: 110 }}>My phone</span>
                        <input value={phone} onChange={e => setPhone(e.target.value)} placeholder="919876543210"
                            inputMode="tel" style={{ ...input, width: 170 }} />
                        <button onClick={() => save({ phone: phone.trim() || null })} disabled={busy}
                            style={{ ...btn(busy), marginTop: 0 }}>Save</button>
                    </div>
                    <div style={{ fontSize: 11.5, color: 'var(--cr-muted)', marginTop: 4 }}>
                        Digits with country code. Leave empty to use the WhatsApp you connected.
                    </div>

                    <div style={{ marginTop: 14, display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                        <span style={{ fontSize: 12.5, color: 'var(--cr-muted)', minWidth: 110 }}>Quiet hours</span>
                        <input type="time" value={prefs.quietStart ?? ''} disabled={busy} style={input}
                            onChange={e => save({ quietStart: e.target.value || null })} />
                        <span style={{ fontSize: 12.5, color: 'var(--cr-muted)' }}>to</span>
                        <input type="time" value={prefs.quietEnd ?? ''} disabled={busy} style={input}
                            onChange={e => save({ quietEnd: e.target.value || null })} />
                    </div>
                    <div style={{ fontSize: 11.5, color: 'var(--cr-muted)', marginTop: 4 }}>
                        Nothing is sent in this window; what waits arrives as one list after it.
                    </div>

                    <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
                        <button onClick={test} disabled={busy || delivery.mode === 'none'} style={btn(busy || delivery.mode === 'none')}>
                            Send a test message
                        </button>
                        {'Notification' in window && Notification.permission === 'default' && (
                            <button onClick={() => { void Notification.requestPermission().then(() => setMsg({ ok: true, text: 'Desktop pop-ups set.' })) }}
                                style={{ ...btn(false), background: 'transparent', border: '1px solid var(--cr-border)', color: 'var(--cr-sub)' }}>
                                Also show desktop pop-ups
                            </button>
                        )}
                    </div>
                </>
            )}

            {msg && (
                <div style={{ marginTop: 10, fontSize: 12.5, color: msg.ok ? 'var(--cr-success, #3fb950)' : 'var(--cr-error)' }}>{msg.text}</div>
            )}
        </div>
    )
}
