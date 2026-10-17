import type { CSSProperties } from 'react'

/**
 * "Continue with Google" — a plain anchor (full-page navigation, not fetch) so the
 * browser follows the OAuth redirect to Google and back to /api/auth/google/callback.
 */
export function GoogleButton({ label = 'Continue with Google' }: { label?: string }) {
    return (
        <a href="/api/auth/google" style={btn}
            onMouseEnter={e => (e.currentTarget.style.background = 'var(--cr-tint-4)')}
            onMouseLeave={e => (e.currentTarget.style.background = 'var(--cr-tint-1)')}>
            <svg width="16" height="16" viewBox="0 0 48 48" aria-hidden>
                <path fill="var(--cr-warn)" d="M43.6 20.5H42V20H24v8h11.3c-1.6 4.7-6.1 8-11.3 8-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.9 1.2 8 3.1l5.7-5.7C34 6.1 29.3 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.3-.4-3.5z" />
                <path fill="var(--cr-orange)" d="M6.3 14.7l6.6 4.8C14.7 16 19 13 24 13c3.1 0 5.9 1.2 8 3.1l5.7-5.7C34 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z" />
                <path fill="var(--cr-green)" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2c-2 1.4-4.5 2.3-7.2 2.3-5.2 0-9.6-3.3-11.2-8l-6.5 5C9.6 39.6 16.2 44 24 44z" />
                <path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.2-2.2 4.1-4.1 5.4l6.2 5.2C40.9 36 44 30.5 44 24c0-1.3-.1-2.3-.4-3.5z" />
            </svg>
            {label}
        </a>
    )
}

const btn: CSSProperties = {
    display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 10,
    padding: '10px', borderRadius: 8, textDecoration: 'none',
    border: '1px solid var(--cr-border)',
    background: 'var(--cr-tint-1)', color: 'var(--cr-text)',
    fontSize: 13, fontWeight: 600, transition: 'background 0.15s',
}

/** Small "or" divider for stacking Google + email auth. */
export const orDivider = (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, color: 'var(--cr-muted)', fontSize: 11 }}>
        <div style={{ flex: 1, height: 1, background: 'var(--cr-border)' }} />
        or
        <div style={{ flex: 1, height: 1, background: 'var(--cr-border)' }} />
    </div>
)
