import { useState } from 'react'
import type { FormEvent } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { useAuthStore } from '../stores/authStore'
import PasswordInput from '../components/PasswordInput'
import AuthLanding, { authCard, authField, authLabel, authInput, authErr, authFormCol, authPrimaryBtn, authNotice } from '../components/AuthLanding'

export default function ForgotPasswordPage() {
    const navigate = useNavigate()
    const requestReset = useAuthStore((s) => s.requestPasswordReset)
    const resetPassword = useAuthStore((s) => s.resetPassword)
    const [step, setStep] = useState<'email' | 'code'>('email')
    const [email, setEmail] = useState('')
    const [code, setCode] = useState('')
    const [password, setPassword] = useState('')
    const [confirm, setConfirm] = useState('')
    const [error, setError] = useState<string | null>(null)
    const [busy, setBusy] = useState(false)
    const [done, setDone] = useState(false)

    const sendCode = async (e: FormEvent) => {
        e.preventDefault(); setError(null); setBusy(true)
        try { await requestReset(email.trim()); setStep('code') }
        catch { setStep('code') } // never reveal existence
        finally { setBusy(false) }
    }

    const submitReset = async (e: FormEvent) => {
        e.preventDefault(); setError(null)
        if (password !== confirm) { setError('Passwords do not match.'); return }
        if (password.length < 8) { setError('Password must be at least 8 characters.'); return }
        setBusy(true)
        try {
            await resetPassword(email.trim(), code.trim(), password)
            setDone(true)
            setTimeout(() => navigate('/'), 1500)
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Could not reset password')
        } finally { setBusy(false) }
    }

    const helpText: React.CSSProperties = { fontSize: 12.5, color: 'var(--cr-sub)', margin: 0, lineHeight: 1.5 }

    return (
        <AuthLanding mode="login">
            <form onSubmit={step === 'email' ? sendCode : submitReset} style={authCard}>
                <div style={{ fontSize: 13, color: 'var(--cr-sub)', fontWeight: 600 }}>Reset your password</div>

                {done ? (
                    <div style={authNotice}>✓ Password updated. Signing you in…</div>
                ) : step === 'email' ? (
                    <>
                        <p style={helpText}>Enter your email and we&apos;ll send you a 6-digit code to reset your password.</p>
                        <div style={authFormCol}>
                            <label style={authField}><span style={authLabel}>Email</span>
                                <input type="email" value={email} onChange={e => setEmail(e.target.value)} autoFocus required autoComplete="username" style={authInput} /></label>
                            {error && <div style={authErr}>{error}</div>}
                            <button type="submit" disabled={busy} style={authPrimaryBtn(busy)}>{busy ? 'Sending…' : 'Send code'}</button>
                        </div>
                    </>
                ) : (
                    <>
                        <p style={helpText}>If an account exists for <strong style={{ color: 'var(--cr-text)' }}>{email}</strong>, a code is on its way. Enter it below with your new password.</p>
                        <div style={authFormCol}>
                            <label style={authField}><span style={authLabel}>Code</span>
                                <input value={code} onChange={e => setCode(e.target.value)} autoFocus required inputMode="numeric" maxLength={6} placeholder="6-digit code" style={authInput} /></label>
                            <label style={authField}><span style={authLabel}>New password</span>
                                <PasswordInput value={password} onChange={setPassword} autoComplete="new-password" minLength={8} style={authInput} /></label>
                            <label style={authField}><span style={authLabel}>Confirm password</span>
                                <PasswordInput value={confirm} onChange={setConfirm} autoComplete="new-password" style={authInput} /></label>
                            {error && <div style={authErr}>{error}</div>}
                            <button type="submit" disabled={busy} style={authPrimaryBtn(busy)}>{busy ? 'Resetting…' : 'Reset password'}</button>
                        </div>
                    </>
                )}

                {!done && (
                    <div style={{ textAlign: 'center' }}>
                        <Link to="/" style={{ fontSize: 13, color: 'var(--cr-sub)', textDecoration: 'none' }}>← Back to sign in</Link>
                    </div>
                )}
            </form>
        </AuthLanding>
    )
}
