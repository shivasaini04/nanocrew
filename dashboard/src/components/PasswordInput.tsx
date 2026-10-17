import { useState } from 'react'
import type { CSSProperties } from 'react'

// Password field with a plain-text Show/Hide toggle (text, not an icon — avoids any
// icon-font rendering issues). Drop-in replacement for an <input type="password">.
export default function PasswordInput({
    value, onChange, style, autoComplete, autoFocus, placeholder, required = true, minLength,
}: {
    value: string
    onChange: (v: string) => void
    style?: CSSProperties
    autoComplete?: string
    autoFocus?: boolean
    placeholder?: string
    required?: boolean
    minLength?: number
}) {
    const [show, setShow] = useState(false)
    return (
        <div style={{ position: 'relative', width: '100%' }}>
            <input
                type={show ? 'text' : 'password'}
                value={value}
                onChange={e => onChange(e.target.value)}
                required={required}
                autoFocus={autoFocus}
                autoComplete={autoComplete}
                placeholder={placeholder}
                minLength={minLength}
                style={{ ...style, paddingRight: 56 }}
            />
            <button
                type="button"
                onClick={() => setShow(s => !s)}
                tabIndex={-1}
                aria-label={show ? 'Hide password' : 'Show password'}
                style={{
                    position: 'absolute', right: 12, top: '50%', transform: 'translateY(-50%)',
                    background: 'none', border: 'none', padding: 0, cursor: 'pointer',
                    fontSize: 12, fontWeight: 600, color: 'var(--cr-sub)',
                }}
            >
                {show ? 'Hide' : 'Show'}
            </button>
        </div>
    )
}
