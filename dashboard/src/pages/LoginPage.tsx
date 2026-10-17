import { useState } from 'react'
import type { FormEvent } from 'react'
import { Link } from 'react-router-dom'
import { useAuthStore } from '../stores/authStore'
import { GoogleButton, orDivider } from '../components/GoogleButton'
import PasswordInput from '../components/PasswordInput'
import AuthLanding, { authCard, authField, authLabel, authInput, authErr, authLink, authMutedLink, authRowBetween, authFormCol, authPrimaryBtn, authEmailBtn, authBack } from '../components/AuthLanding'

export default function LoginPage() {
    const login = useAuthStore((s) => s.login)
    const loginRequest = useAuthStore((s) => s.loginRequest)
    const loginVerify = useAuthStore((s) => s.loginVerify)
    const signupOpen = useAuthStore((s) => s.signupOpen)

    const [view, setView] = useState<'choose' | 'email'>('choose')
    const [mode, setMode] = useState<'password' | 'otp'>('password')
    const [otpStep, setOtpStep] = useState<'email' | 'code'>('email')
    const [email, setEmail] = useState('')
    const [password, setPassword] = useState('')
    const [code, setCode] = useState('')
    const [error, setError] = useState<string | null>(null)
    const [busy, setBusy] = useState(false)

    const run = async (fn: () => Promise<void>, after?: () => void) => {
        setError(null); setBusy(true)
        try { await fn(); after?.() }
        catch (err) { setError(err instanceof Error ? err.message : 'Something went wrong') }
        finally { setBusy(false) }
    }

    const onPassword = (e: FormEvent) => { e.preventDefault(); run(() => login(email.trim(), password)) }
    const onSendCode = (e: FormEvent) => { e.preventDefault(); run(() => loginRequest(email.trim()), () => setOtpStep('code')) }
    const onVerifyCode = (e: FormEvent) => { e.preventDefault(); run(() => loginVerify(email.trim(), code.trim())) }

    const backToChoose = () => { setView('choose'); setMode('password'); setOtpStep('email'); setError(null) }

    return (
        <AuthLanding mode="login">
            <div style={authCard}>
                <div style={{ fontSize: 13, color: 'var(--cr-sub)', fontWeight: 600 }}>Sign in to your dashboard</div>

                {view === 'choose' ? (
                    <>
                        <GoogleButton />
                        {orDivider}
                        <button type="button" onClick={() => { setView('email'); setError(null) }} style={authEmailBtn}>Continue with email</button>
                        {signupOpen && (
                            <div style={{ textAlign: 'center', marginTop: 2 }}>
                                <Link to="/signup" style={{ fontSize: 13, color: 'var(--cr-sub)', textDecoration: 'none' }}>Need an account? <span style={{ color: 'var(--cr-accent)' }}>Create one</span></Link>
                            </div>
                        )}
                    </>
                ) : (
                    <>
                        <button type="button" onClick={backToChoose} style={authBack}>← All sign-in options</button>

                        {mode === 'password' ? (
                            <form onSubmit={onPassword} style={authFormCol}>
                                <label style={authField}><span style={authLabel}>Email</span>
                                    <input type="email" value={email} onChange={e => setEmail(e.target.value)} autoFocus required autoComplete="username" style={authInput} /></label>
                                <label style={authField}><span style={authLabel}>Password</span>
                                    <PasswordInput value={password} onChange={setPassword} autoComplete="current-password" style={authInput} /></label>
                                {error && <div style={authErr}>{error}</div>}
                                <button type="submit" disabled={busy} style={authPrimaryBtn(busy)}>{busy ? 'Signing in…' : 'Sign in'}</button>
                                <div style={authRowBetween}>
                                    <button type="button" onClick={() => { setMode('otp'); setError(null) }} style={authLink}>Sign in with a code</button>
                                    <Link to="/forgot-password" style={authMutedLink}>Forgot password?</Link>
                                </div>
                            </form>
                        ) : otpStep === 'email' ? (
                            <form onSubmit={onSendCode} style={authFormCol}>
                                <label style={authField}><span style={authLabel}>Email</span>
                                    <input type="email" value={email} onChange={e => setEmail(e.target.value)} autoFocus required autoComplete="username" style={authInput} /></label>
                                {error && <div style={authErr}>{error}</div>}
                                <button type="submit" disabled={busy} style={authPrimaryBtn(busy)}>{busy ? 'Sending…' : 'Email me a code'}</button>
                                <div style={{ textAlign: 'center' }}>
                                    <button type="button" onClick={() => { setMode('password'); setError(null) }} style={authLink}>← Use password instead</button>
                                </div>
                            </form>
                        ) : (
                            <form onSubmit={onVerifyCode} style={authFormCol}>
                                <p style={{ fontSize: 12.5, color: 'var(--cr-sub)', margin: 0, lineHeight: 1.5 }}>
                                    If an account exists for <strong style={{ color: 'var(--cr-text)' }}>{email}</strong>, a sign-in code is on its way.
                                </p>
                                <label style={authField}><span style={authLabel}>Code</span>
                                    <input value={code} onChange={e => setCode(e.target.value)} autoFocus required inputMode="numeric" maxLength={6} placeholder="6-digit code" style={authInput} /></label>
                                {error && <div style={authErr}>{error}</div>}
                                <button type="submit" disabled={busy} style={authPrimaryBtn(busy)}>{busy ? 'Verifying…' : 'Sign in'}</button>
                                <div style={{ textAlign: 'center' }}>
                                    <button type="button" onClick={() => { setOtpStep('email'); setCode(''); setError(null) }} style={authLink}>← Back</button>
                                </div>
                            </form>
                        )}
                    </>
                )}
            </div>
        </AuthLanding>
    )
}
