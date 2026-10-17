import { useState } from 'react'
import { reportMobileInterest } from '../lib/api'

const DISMISS_KEY = 'nanocrew_mobile_gate_dismissed'

/**
 * Full-screen gate shown on narrow viewports instead of the dashboard shell (sidebar +
 * chat + panels), which isn't responsive yet. Offers a one-tap "notify me" and an escape
 * hatch for anyone who genuinely needs mobile access right now — dismissal is per-tab
 * (sessionStorage) so it doesn't nag again until the browser session ends.
 */
export default function MobileGate({ onContinue }: { onContinue: () => void }) {
    const [notified, setNotified] = useState(false)
    const [busy, setBusy] = useState(false)

    async function notifyMe() {
        setBusy(true)
        try { await reportMobileInterest() } catch { /* best-effort */ }
        setNotified(true)
        setBusy(false)
    }

    function continueAnyway() {
        try { sessionStorage.setItem(DISMISS_KEY, '1') } catch { /* ignore */ }
        onContinue()
    }

    return (
        <div style={{
            position: 'fixed', inset: 0, zIndex: 10000, display: 'flex', flexDirection: 'column',
            alignItems: 'center', justifyContent: 'center', textAlign: 'center', padding: '32px 24px',
            background: 'var(--cr-bg-main)', color: 'var(--cr-text)',
            fontFamily: 'var(--cr-font-sans, system-ui, sans-serif)',
        }}>
            <img src="/nanocrew-logo.png" alt="nanocrew" style={{ width: 40, height: 40, objectFit: 'contain', marginBottom: 20 }} />
            <div style={{ fontFamily: 'var(--cr-font-serif, "DM Serif Display", serif)', fontSize: 26, marginBottom: 12, maxWidth: 340 }}>
                nanocrew works best on desktop
            </div>
            <p style={{ fontSize: 14, lineHeight: 1.6, color: 'var(--cr-sub)', maxWidth: 320, margin: '0 0 28px' }}>
                Open this link on your laptop or computer to manage your crew. We're building a proper mobile experience — want us to email you when it's ready?
            </p>

            {notified ? (
                <div style={{ fontSize: 13.5, color: 'var(--cr-accent)', marginBottom: 22 }}>✅ Thanks — we'll let you know.</div>
            ) : (
                <button onClick={notifyMe} disabled={busy} style={{
                    padding: '12px 26px', borderRadius: 999, border: 'none', cursor: busy ? 'default' : 'pointer',
                    fontSize: 14, fontWeight: 600, color: 'var(--cr-on-accent)',
                    background: 'linear-gradient(135deg, var(--cr-accent), var(--cr-accent-warm))',
                    opacity: busy ? 0.7 : 1, marginBottom: 22,
                }}>
                    {busy ? 'Sending…' : 'Notify me when it\'s ready'}
                </button>
            )}

            <button onClick={continueAnyway} style={{
                background: 'none', border: 'none', color: 'var(--cr-muted)', fontSize: 12.5,
                textDecoration: 'underline', cursor: 'pointer', padding: 4,
            }}>
                Continue anyway (not optimized for mobile)
            </button>
        </div>
    )
}

export function isMobileGateDismissed(): boolean {
    try { return sessionStorage.getItem(DISMISS_KEY) === '1' } catch { return false }
}
