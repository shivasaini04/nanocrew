import { create } from 'zustand'

export type ThemeChoice = 'system' | 'light' | 'dark'
export type ResolvedTheme = 'light' | 'dark'

/** Shared with the pre-paint script in index.html — change both together. */
const STORAGE_KEY = 'nc-theme'

const lightQuery = () => window.matchMedia('(prefers-color-scheme: light)')

function readChoice(): ThemeChoice {
    try {
        const saved = localStorage.getItem(STORAGE_KEY)
        if (saved === 'light' || saved === 'dark') return saved
    } catch {
        // Safari private mode / blocked storage — fall through to system.
    }
    return 'system'
}

function resolve(choice: ThemeChoice): ResolvedTheme {
    if (choice !== 'system') return choice
    try {
        return lightQuery().matches ? 'light' : 'dark'
    } catch {
        return 'dark'
    }
}

/**
 * `color-scheme` is what makes native UI (scrollbars, <select> popups, date pickers,
 * form controls, the overscroll gutter) follow the theme. CSS variables can't reach
 * those — without this, light mode gets black scrollbars and white-on-white dropdowns.
 */
function apply(resolved: ResolvedTheme) {
    document.documentElement.setAttribute('data-theme', resolved)
    document.documentElement.style.colorScheme = resolved
}

interface ThemeState {
    /** What the user picked: an explicit theme, or 'system' to track the OS. */
    choice: ThemeChoice
    /** What is actually on screen right now. */
    resolved: ResolvedTheme
    setChoice: (choice: ThemeChoice) => void
    /** Flip to the opposite of what's currently showing (pins an explicit choice). */
    toggle: () => void
}

const initialChoice = readChoice()

export const useThemeStore = create<ThemeState>((set, get) => ({
    choice: initialChoice,
    resolved: resolve(initialChoice),

    setChoice: (choice) => {
        const resolved = resolve(choice)
        try {
            // 'system' is stored as absence, so a user who never chooses keeps
            // following the OS forever rather than being frozen at whatever the
            // OS happened to be on their first visit.
            if (choice === 'system') localStorage.removeItem(STORAGE_KEY)
            else localStorage.setItem(STORAGE_KEY, choice)
        } catch {
            // Storage blocked — theme still applies for this session, just isn't remembered.
        }
        apply(resolved)
        set({ choice, resolved })
    },

    toggle: () => {
        get().setChoice(get().resolved === 'dark' ? 'light' : 'dark')
    },
}))

// index.html already applied the correct theme pre-paint; re-apply so the DOM can't
// drift from the store if either side's fallback logic changes.
apply(useThemeStore.getState().resolved)

// Follow the OS live, but only while the user hasn't pinned a choice.
try {
    lightQuery().addEventListener('change', (e) => {
        if (useThemeStore.getState().choice !== 'system') return
        const resolved: ResolvedTheme = e.matches ? 'light' : 'dark'
        apply(resolved)
        useThemeStore.setState({ resolved })
    })
} catch {
    // Older browsers without addEventListener on MediaQueryList — static theme is fine.
}
