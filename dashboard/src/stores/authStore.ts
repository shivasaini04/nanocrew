import { create } from 'zustand'
import { socket } from '../lib/socket'

export interface AuthUser {
    id: string
    email: string
    role: 'admin' | 'user'
    status: 'active' | 'suspended'
    created_at: string
    last_active: string | null
    /** ISO ts when first-run onboarding finished; null/absent = not yet onboarded. */
    onboarded_at?: string | null
    /** Entitlement tier (standard|pro|business). null/absent/empty = no active plan → must subscribe. */
    plan?: string | null
}

interface AuthState {
    user: AuthUser | null
    status: 'loading' | 'authed' | 'anon'
    /** Whether self-serve signup is enabled (mirrors backend SIGNUP_OPEN). */
    signupOpen: boolean
    /** True when an admin is "viewing as" a client. `user` is then the client. */
    impersonating: boolean
    /** The real admin's email while impersonating (for the support banner). */
    realEmail: string | null
    /** Admin: start viewing as a client, then reload into their dashboard. */
    startImpersonation: (clientId: string) => Promise<void>
    /** Exit "view as client" and return to the admin panel. */
    stopImpersonation: () => Promise<void>
    /** Check the current session on app boot (GET /api/auth/me). */
    checkAuth: () => Promise<void>
    /** Fetch public auth config (signupOpen) so the UI can show/hide signup. */
    fetchConfig: () => Promise<void>
    /** Log in; throws Error(message) on failure so the form can show it. */
    login: (email: string, password: string) => Promise<void>
    /** Signup step 1: validate + email a verification code; throws on failure. */
    signupRequest: (email: string, password: string) => Promise<void>
    /** Signup step 2: verify the code → account created + logged in; throws on failure. */
    signupVerify: (email: string, code: string) => Promise<void>
    /** Passwordless login step 1: email a sign-in code. Always resolves. */
    loginRequest: (email: string) => Promise<void>
    /** Passwordless login step 2: verify the code → logged in; throws on failure. */
    loginVerify: (email: string, code: string) => Promise<void>
    /** Email a password-reset code. Always resolves (no account enumeration). */
    requestPasswordReset: (email: string) => Promise<void>
    /** Complete a password reset with the emailed code; throws on failure. */
    resetPassword: (email: string, code: string, password: string) => Promise<void>
    logout: () => Promise<void>
    /** Force the app back to the login screen (used by the global 401 handler). */
    setAnon: () => void
    /** Mark first-run onboarding complete (POST /api/auth/onboarded) + update the user. */
    completeOnboarding: () => Promise<void>
}

export const useAuthStore = create<AuthState>((set) => ({
    user: null,
    status: 'loading',
    signupOpen: false,
    impersonating: false,
    realEmail: null,

    checkAuth: async () => {
        try {
            const res = await fetch('/api/auth/me')
            if (!res.ok) {
                set({ user: null, status: 'anon' })
                return
            }
            const data = await res.json()
            set({ user: data.user, status: 'authed', impersonating: !!data.impersonating, realEmail: data.realEmail ?? null })
        } catch {
            set({ user: null, status: 'anon' })
        }
    },

    startImpersonation: async (clientId) => {
        const res = await fetch(`/api/admin/clients/${clientId}/impersonate`, { method: 'POST' })
        if (!res.ok) {
            const d = await res.json().catch(() => ({}))
            throw new Error(d.error || 'Failed to start view-as-client')
        }
        // Hard reload so every store + the socket re-initialize as the client.
        window.location.href = '/'
    },

    stopImpersonation: async () => {
        try { await fetch('/api/auth/stop-impersonating', { method: 'POST' }) } catch { /* ignore */ }
        window.location.href = '/admin'
    },

    fetchConfig: async () => {
        try {
            const res = await fetch('/api/auth/config')
            if (!res.ok) return
            const data = await res.json()
            set({ signupOpen: !!data.signupOpen })
        } catch { /* leave default (false) */ }
    },

    login: async (email, password) => {
        const res = await fetch('/api/auth/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email, password }),
        })
        if (!res.ok) {
            const data = await res.json().catch(() => ({}))
            throw new Error(data.error || 'Login failed. Please try again.')
        }
        const data = await res.json()
        set({ user: data.user, status: 'authed' })
    },

    requestPasswordReset: async (email) => {
        await fetch('/api/auth/forgot-password', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email }),
        })
        // Always resolves — server never reveals whether the email exists.
    },

    resetPassword: async (email, code, password) => {
        const res = await fetch('/api/auth/reset-password', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email, code, password }),
        })
        if (!res.ok) {
            const d = await res.json().catch(() => ({}))
            throw new Error(d.error || 'Could not reset password.')
        }
    },

    signupRequest: async (email, password) => {
        const res = await fetch('/api/auth/signup/request', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email, password }),
        })
        if (!res.ok) {
            const data = await res.json().catch(() => ({}))
            throw new Error(data.error || 'Signup failed. Please try again.')
        }
    },

    signupVerify: async (email, code) => {
        const res = await fetch('/api/auth/signup/verify', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email, code }),
        })
        if (!res.ok) {
            const data = await res.json().catch(() => ({}))
            throw new Error(data.error || 'Invalid or expired code.')
        }
        const data = await res.json()
        set({ user: data.user, status: 'authed' })
    },

    loginRequest: async (email) => {
        await fetch('/api/auth/login/request', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email }),
        })
    },

    loginVerify: async (email, code) => {
        const res = await fetch('/api/auth/login/verify', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email, code }),
        })
        if (!res.ok) {
            const data = await res.json().catch(() => ({}))
            throw new Error(data.error || 'Invalid or expired code.')
        }
        const data = await res.json()
        set({ user: data.user, status: 'authed' })
    },

    logout: async () => {
        try { await fetch('/api/auth/logout', { method: 'POST' }) } catch { /* ignore */ }
        try { socket.disconnect() } catch { /* ignore */ }
        set({ user: null, status: 'anon' })
    },

    setAnon: () => set({ user: null, status: 'anon' }),

    completeOnboarding: async () => {
        try {
            const res = await fetch('/api/auth/onboarded', { method: 'POST' })
            if (res.ok) {
                const data = await res.json()
                set((s) => ({ user: data.user ?? (s.user ? { ...s.user, onboarded_at: new Date().toISOString() } : s.user) }))
                return
            }
        } catch { /* fall through to optimistic update so the user is never stuck */ }
        // Optimistic fallback — never leave the user trapped behind the overlay.
        set((s) => ({ user: s.user ? { ...s.user, onboarded_at: new Date().toISOString() } : s.user }))
    },
}))
