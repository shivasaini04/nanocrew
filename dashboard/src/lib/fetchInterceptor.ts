import { useAuthStore } from '../stores/authStore'

/**
 * Global 401 handler. The dashboard makes ~160 fetch() calls, most not routed
 * through a shared client. Rather than touch every call site, we wrap window.fetch
 * once: any /api response that comes back 401 (other than the auth endpoints
 * themselves) means the session is gone, so we flip the app back to the login screen.
 * Installed for its side effect — imported once from main.tsx before the app renders.
 */
const originalFetch = window.fetch.bind(window)

window.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const res = await originalFetch(input, init)
    if (res.status === 401) {
        const url =
            typeof input === 'string'
                ? input
                : input instanceof URL
                    ? input.href
                    : input instanceof Request
                        ? input.url
                        : String(input)
        if (url.includes('/api/') && !url.includes('/api/auth/')) {
            useAuthStore.getState().setAnon()
        }
    }
    return res
}
