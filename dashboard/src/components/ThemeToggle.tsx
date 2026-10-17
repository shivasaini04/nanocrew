import { Moon, Sun } from 'lucide-react'
import { useThemeStore } from '../stores/themeStore'

/**
 * Light/dark switch — a sliding track with the knob sitting at the moon end in dark
 * mode and the sun end in light mode. Used only in the sidebar now that the topbar is
 * gone. A single button that swapped its icon on click read as "here's what you'd get
 * if you clicked" — the right shape for a switch is to show the state you're IN via
 * where the knob sits, the same way any light-switch-style control works.
 */
export default function ThemeToggle({ compact = false }: { compact?: boolean }) {
    const resolved = useThemeStore((s) => s.resolved)
    const toggle = useThemeStore((s) => s.toggle)
    const isDark = resolved === 'dark'

    const w = compact ? 48 : 54
    const h = compact ? 24 : 27
    const pad = 3
    const knob = h - pad * 2
    const iconSize = Math.round(knob * 0.58)

    return (
        <button
            onClick={toggle}
            role="switch"
            aria-checked={isDark}
            aria-label={`Switch to ${isDark ? 'light' : 'dark'} mode`}
            title={`Switch to ${isDark ? 'light' : 'dark'} mode`}
            style={{
                position: 'relative',
                width: w,
                height: h,
                borderRadius: h / 2,
                flexShrink: 0,
                border: '1px solid var(--cr-border)',
                background: 'var(--cr-tint-3)',
                cursor: 'pointer',
                padding: 0,
                transition: 'border-color 0.15s',
            }}
            onMouseEnter={(e) => { e.currentTarget.style.borderColor = 'var(--cr-border-bright)' }}
            onMouseLeave={(e) => { e.currentTarget.style.borderColor = 'var(--cr-border)' }}
        >
            {/* Dim icon on the empty end — the side the knob isn't currently covering */}
            {isDark ? (
                <Sun size={iconSize} style={{
                    position: 'absolute', right: (h - iconSize) / 2, top: '50%', transform: 'translateY(-50%)',
                    color: 'var(--cr-muted)', pointerEvents: 'none',
                }} />
            ) : (
                <Moon size={iconSize} style={{
                    position: 'absolute', left: (h - iconSize) / 2, top: '50%', transform: 'translateY(-50%)',
                    color: 'var(--cr-muted)', pointerEvents: 'none',
                }} />
            )}

            {/* Sliding knob — carries the icon for the state you're in */}
            <div style={{
                position: 'absolute',
                top: pad,
                left: isDark ? pad : w - knob - pad,
                width: knob,
                height: knob,
                borderRadius: '50%',
                background: 'var(--cr-accent)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                color: 'var(--cr-on-accent)',
                boxShadow: '0 1px 3px var(--cr-shade-2)',
                transition: 'left 0.25s cubic-bezier(0.4, 0, 0.2, 1)',
            }}>
                {isDark ? <Moon size={iconSize} /> : <Sun size={iconSize} />}
            </div>
        </button>
    )
}
