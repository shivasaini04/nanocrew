import { useState } from 'react'
import type { FormEvent } from 'react'
import { Link } from 'react-router-dom'
import { useAuthStore } from '../stores/authStore'
import { GoogleButton, orDivider } from '../components/GoogleButton'
import PasswordInput from '../components/PasswordInput'
import AuthLanding, { authCard, authField, authLabel, authInput, authErr, authLink, authNotice, authFormCol, authPrimaryBtn, authEmailBtn, authBack } from '../components/AuthLanding'


export default function SignupPage() {
    const signupRequest = useAuthStore((s) => s.signupRequest)
    const signupVerify = useAuthStore((s) => s.signupVerify)
    const signupOpen = useAuthStore((s) => s.signupOpen)
    const [view, setView] = useState<'choose' | 'email'>('choose')
    const [step, setStep] = useState<'form' | 'code'>('form')
    const [email, setEmail] = useState('')
    const [password, setPassword] = useState('')
    const [confirm, setConfirm] = useState('')
    const [code, setCode] = useState('')
    const [error, setError] = useState<string | null>(null)
    const [busy, setBusy] = useState(false)

    const submitForm = async (e: FormEvent) => {
        e.preventDefault(); setError(null)
        if (password !== confirm) { setError('Passwords do not match.'); return }
        if (password.length < 8) { setError('Password must be at least 8 characters.'); return }
        setBusy(true)
        try { await signupRequest(email.trim(), password); setStep('code') }
        catch (err) { setError(err instanceof Error ? err.message : 'Signup failed') }
        finally { setBusy(false) }
    }

    const submitCode = async (e: FormEvent) => {
        e.preventDefault(); setError(null); setBusy(true)
        try { await signupVerify(email.trim(), code.trim()) }
        catch (err) { setError(err instanceof Error ? err.message : 'Invalid code') }
        finally { setBusy(false) }
    }

    return (
        <AuthLanding mode="signup">
            <div style={authCard}>
                <div style={{ fontSize: 13, color: 'var(--cr-sub)', fontWeight: 600 }}>Create your account</div>

                {!signupOpen ? (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
                        <div style={authNotice}>Sign-ups are currently invite-only. Please contact us for access.</div>
                        <Link to="/" style={{ ...authLink, textAlign: 'center' }}>← Back to sign in</Link>
                    </div>
                ) : step === 'code' ? (
                    <form onSubmit={submitCode} style={authFormCol}>
                        <p style={{ fontSize: 12.5, color: 'var(--cr-sub)', margin: 0, lineHeight: 1.5 }}>
                            We sent a 6-digit code to <strong style={{ color: 'var(--cr-text)' }}>{email}</strong>. Enter it to finish.
                        </p>
                        <label style={authField}><span style={authLabel}>Verification code</span>
                            <input value={code} onChange={e => setCode(e.target.value)} autoFocus required inputMode="numeric" maxLength={6} placeholder="6-digit code" style={authInput} /></label>
                        {error && <div style={authErr}>{error}</div>}
                        <button type="submit" disabled={busy} style={authPrimaryBtn(busy)}>{busy ? 'Verifying…' : 'Create account'}</button>
                        <div style={{ textAlign: 'center' }}>
                            <button type="button" onClick={() => { setStep('form'); setCode('') }} style={authLink}>← Use a different email</button>
                        </div>
                    </form>
                ) : view === 'choose' ? (
                    <>
                        <GoogleButton label="Sign up with Google" />
                        {orDivider}
                        <button type="button" onClick={() => { setView('email'); setError(null) }} style={authEmailBtn}>Continue with email</button>
                        <div style={{ textAlign: 'center', marginTop: 2 }}>
                            <Link to="/" style={{ fontSize: 13, color: 'var(--cr-sub)', textDecoration: 'none' }}>Already have an account? <span style={{ color: 'var(--cr-accent)' }}>Sign in</span></Link>
                        </div>
                    </>
                ) : (
                    <>
                        <button type="button" onClick={() => { setView('choose'); setError(null) }} style={authBack}>← All sign-up options</button>
                        <form onSubmit={submitForm} style={authFormCol}>
                            <label style={authField}><span style={authLabel}>Email</span>
                                <input type="email" value={email} onChange={e => setEmail(e.target.value)} autoFocus required autoComplete="username" style={authInput} /></label>
                            <label style={authField}><span style={authLabel}>Password</span>
                                <PasswordInput value={password} onChange={setPassword} autoComplete="new-password" minLength={8} style={authInput} /></label>
                            <label style={authField}><span style={authLabel}>Confirm password</span>
                                <PasswordInput value={confirm} onChange={setConfirm} autoComplete="new-password" style={authInput} /></label>
                            {error && <div style={authErr}>{error}</div>}
                            <button type="submit" disabled={busy} style={authPrimaryBtn(busy)}>{busy ? 'Sending code…' : 'Continue'}</button>
                        </form>
                    </>
                )}
            </div>
        </AuthLanding>
    )
}
