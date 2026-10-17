import { useEffect, useState, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'

interface Shortcut {
    keys: string
    description: string
    action?: () => void
}

const NAV_SHORTCUTS: { key: string; path: string; label: string }[] = [
    { key: 'h', path: '/', label: 'Command Center' },
    { key: 'a', path: '/agents', label: 'Agents' },
    { key: 'f', path: '/files', label: 'Files' },
    { key: 'p', path: '/projects', label: 'Projects' },
    { key: 'm', path: '/crew', label: 'Crew Map' },
    { key: 'n', path: '/notifications', label: 'Notifications' },
    { key: 'r', path: '/research', label: 'Research' },
    { key: 'k', path: '/checkins', label: 'Check-ins' },
    { key: 'x', path: '/approvals', label: 'Approvals' },
    { key: 's', path: '/system/settings', label: 'Settings' },
]

export default function KeyboardShortcuts() {
    const navigate = useNavigate()
    const [open, setOpen] = useState(false)
    const [gArmed, setGArmed] = useState(false)
    const [gTimer, setGTimer] = useState<ReturnType<typeof setTimeout> | null>(null)

    const close = useCallback(() => setOpen(false), [])

    useEffect(() => {
        function onKey(e: KeyboardEvent) {
            // Ignore when typing in an input/textarea/select
            const tag = (e.target as HTMLElement).tagName
            if (['INPUT', 'TEXTAREA', 'SELECT'].includes(tag)) return
            if (e.metaKey || e.ctrlKey || e.altKey) return

            const key = e.key

            // Escape closes modal or disarms g
            if (key === 'Escape') {
                if (open) { setOpen(false); return }
                if (gArmed) { setGArmed(false); return }
                return
            }

            // ? toggles shortcuts modal
            if (key === '?') {
                e.preventDefault()
                setOpen(v => !v)
                setGArmed(false)
                return
            }

            // g arms the nav shortcut chord
            if (!gArmed && key === 'g') {
                e.preventDefault()
                setGArmed(true)
                if (gTimer) clearTimeout(gTimer)
                const t = setTimeout(() => setGArmed(false), 1500)
                setGTimer(t)
                return
            }

            // g + letter navigates
            if (gArmed) {
                e.preventDefault()
                setGArmed(false)
                if (gTimer) clearTimeout(gTimer)
                const nav = NAV_SHORTCUTS.find(s => s.key === key)
                if (nav) navigate(nav.path)
                return
            }
        }

        window.addEventListener('keydown', onKey)
        return () => window.removeEventListener('keydown', onKey)
    }, [open, gArmed, gTimer, navigate])

    if (!open) {
        return gArmed ? (
            <div style={{
                position: 'fixed', bottom: 20, left: '50%', transform: 'translateX(-50%)',
                background: 'var(--cr-bg-card)', border: '1px solid var(--cr-border-bright)',
                borderRadius: 10, padding: '8px 18px', zIndex: 9998,
                fontSize: 13, color: 'var(--cr-accent)', fontFamily: 'var(--cr-font-mono)',
                boxShadow: '0 4px 24px var(--cr-shade-3)',
                display: 'flex', alignItems: 'center', gap: 8,
            }}>
                <span style={{ opacity: 0.5 }}>g</span>
                <span>→</span>
                <span>press a key to navigate…</span>
            </div>
        ) : null
    }

    const sections: { title: string; items: Shortcut[] }[] = [
        {
            title: 'General',
            items: [
                { keys: '?', description: 'Toggle this shortcuts panel' },
                { keys: 'Escape', description: 'Close modal / dismiss' },
            ],
        },
        {
            title: 'Navigation  (press g, then key)',
            items: NAV_SHORTCUTS.map(s => ({
                keys: `g → ${s.key}`,
                description: `Go to ${s.label}`,
            })),
        },
    ]

    return (
        <div
            style={{ position: 'fixed', inset: 0, background: 'var(--cr-scrim)', zIndex: 9999, display: 'flex', alignItems: 'center', justifyContent: 'center', backdropFilter: 'blur(4px)' }}
            onClick={close}
        >
            <div
                onClick={e => e.stopPropagation()}
                style={{
                    background: 'var(--cr-bg-card)',
                    border: '1px solid var(--cr-border-bright)',
                    borderRadius: 14,
                    width: '100%', maxWidth: 500,
                    maxHeight: '80vh', overflowY: 'auto',
                    boxShadow: '0 8px 40px var(--cr-shade-3)',
                }}
            >
                {/* Header */}
                <div style={{ padding: '16px 24px', borderBottom: '1px solid var(--cr-border)', display: 'flex', alignItems: 'center', justifyContent: 'space-between', position: 'sticky', top: 0, background: 'var(--cr-bg-card)', zIndex: 1 }}>
                    <span style={{ fontFamily: 'var(--cr-font-serif)', fontSize: 18, color: 'var(--cr-cream)' }}>Keyboard Shortcuts</span>
                    <button onClick={close} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--cr-muted)', fontSize: 20, lineHeight: 1, padding: '0 4px' }}>×</button>
                </div>

                <div style={{ padding: '20px 24px', display: 'flex', flexDirection: 'column', gap: 24 }}>
                    {sections.map(section => (
                        <div key={section.title}>
                            <div style={{ fontSize: 10, fontWeight: 700, color: 'var(--cr-muted-br)', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 10 }}>
                                {section.title}
                            </div>
                            <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                                {section.items.map((item, i) => (
                                    <div key={i} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '7px 12px', borderRadius: 7, background: 'var(--cr-tint-2)' }}>
                                        <span style={{ fontSize: 13, color: 'var(--cr-sub)' }}>{item.description}</span>
                                        <div style={{ display: 'flex', gap: 4, flexShrink: 0, marginLeft: 12 }}>
                                            {item.keys.split(' → ').map((k, ki) => (
                                                <span key={ki} style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                                                    {ki > 0 && <span style={{ color: 'var(--cr-muted)', fontSize: 10 }}>→</span>}
                                                    <kbd style={{
                                                        display: 'inline-block',
                                                        padding: '2px 8px', borderRadius: 5,
                                                        background: 'var(--cr-bg-main)',
                                                        border: '1px solid var(--cr-border-bright)',
                                                        fontFamily: 'var(--cr-font-mono)', fontSize: 12,
                                                        color: 'var(--cr-cream)', letterSpacing: '0.02em',
                                                        boxShadow: '0 1px 0 var(--cr-border)',
                                                    }}>{k}</kbd>
                                                </span>
                                            ))}
                                        </div>
                                    </div>
                                ))}
                            </div>
                        </div>
                    ))}
                </div>

                <div style={{ padding: '12px 24px', borderTop: '1px solid var(--cr-border)', fontSize: 11, color: 'var(--cr-muted)', textAlign: 'center' }}>
                    Press <kbd style={{ padding: '1px 6px', borderRadius: 4, background: 'var(--cr-tint-4)', border: '1px solid var(--cr-border)', fontFamily: 'var(--cr-font-mono)', fontSize: 11 }}>?</kbd> to toggle · <kbd style={{ padding: '1px 6px', borderRadius: 4, background: 'var(--cr-tint-4)', border: '1px solid var(--cr-border)', fontFamily: 'var(--cr-font-mono)', fontSize: 11 }}>Esc</kbd> to close
                </div>
            </div>
        </div>
    )
}
