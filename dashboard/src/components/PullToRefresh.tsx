import { useEffect, useRef, useState } from 'react'
import { useIsMobile } from '../hooks/useIsMobile'

const PULL_THRESHOLD = 68
const MAX_PULL = 110

/**
 * Finds the element that would actually receive this touch's scroll/gesture, walking
 * up from the touch target. Stops (returns null) at any ancestor that owns its own
 * touch gestures (`touch-action: none` — e.g. the Crew Map's pan/pinch canvas), so we
 * never hijack a gesture a component is already handling itself. Falls back to
 * `.page-content` — the canonical per-route scroller — if nothing more specific
 * (a nested chat body, a drawer's own scroll pane, etc.) is found first.
 */
function findPullTarget(el: EventTarget | null): HTMLElement | null {
    let node = el as HTMLElement | null
    while (node && node !== document.body) {
        const cs = window.getComputedStyle(node)
        if (cs.touchAction === 'none') return null
        if (cs.overflowY === 'auto' || cs.overflowY === 'scroll') return node
        if (node.classList.contains('page-content')) return node
        node = node.parentElement
    }
    return null
}

/** Wraps page content with a native-app-style pull-to-refresh gesture on mobile.
 *  No-op on desktop (renders children directly). Refresh = full reload, matching
 *  what "pull to refresh" means in most mobile web apps — simplest way to guarantee
 *  every page's data is actually fresh without threading a refetch callback through
 *  every route. */
export default function PullToRefresh({ children }: { children: React.ReactNode }) {
    const isMobile = useIsMobile()
    const [pull, setPull] = useState(0)
    const [refreshing, setRefreshing] = useState(false)
    const [dragging, setDragging] = useState(false)
    const startRef = useRef({ x: 0, y: 0 })
    const targetRef = useRef<HTMLElement | null>(null)
    const activeRef = useRef(false)
    const containerRef = useRef<HTMLDivElement>(null)

    useEffect(() => {
        if (!isMobile) return
        const container = containerRef.current
        if (!container) return

        const onTouchStart = (e: TouchEvent) => {
            if (refreshing) return
            const target = findPullTarget(e.target)
            if (!target || target.scrollTop > 0) { activeRef.current = false; return }
            targetRef.current = target
            startRef.current = { x: e.touches[0].clientX, y: e.touches[0].clientY }
            activeRef.current = true
        }
        const onTouchMove = (e: TouchEvent) => {
            if (!activeRef.current || refreshing) return
            const dx = e.touches[0].clientX - startRef.current.x
            const dy = e.touches[0].clientY - startRef.current.y
            if (dy <= 8 || Math.abs(dy) < Math.abs(dx)) { setPull(0); return }
            if (targetRef.current && targetRef.current.scrollTop > 0) { activeRef.current = false; setPull(0); return }
            e.preventDefault()
            setDragging(true)
            setPull(Math.min(MAX_PULL, dy * 0.5))
        }
        const onTouchEnd = () => {
            if (!activeRef.current) return
            activeRef.current = false
            setDragging(false)
            setPull(p => {
                if (p >= PULL_THRESHOLD) {
                    setRefreshing(true)
                    setTimeout(() => window.location.reload(), 200)
                    return PULL_THRESHOLD
                }
                return 0
            })
        }

        container.addEventListener('touchstart', onTouchStart, { passive: true })
        container.addEventListener('touchmove', onTouchMove, { passive: false })
        container.addEventListener('touchend', onTouchEnd)
        container.addEventListener('touchcancel', onTouchEnd)
        return () => {
            container.removeEventListener('touchstart', onTouchStart)
            container.removeEventListener('touchmove', onTouchMove)
            container.removeEventListener('touchend', onTouchEnd)
            container.removeEventListener('touchcancel', onTouchEnd)
        }
    }, [isMobile, refreshing])

    if (!isMobile) return <>{children}</>

    const progress = Math.min(1, pull / PULL_THRESHOLD)
    // Slides the badge in from just off the top edge as you pull, rather than making
    // room for it by pushing content down — content underneath never moves.
    const badgeTop = Math.max(-40, -40 + pull * 0.9)

    return (
        <div ref={containerRef} style={{ position: 'relative', flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
            <div style={{
                position: 'absolute', top: 0, left: 0, right: 0,
                display: 'flex', justifyContent: 'center',
                zIndex: 50, pointerEvents: 'none',
            }}>
                <div style={{
                    marginTop: refreshing ? 14 : badgeTop,
                    width: 32, height: 32, borderRadius: '50%', flexShrink: 0,
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    background: 'var(--cr-bg-elevated)',
                    border: '1px solid var(--cr-border-bright)',
                    boxShadow: '0 6px 20px var(--cr-shade-2)',
                    opacity: refreshing ? 1 : Math.max(0, Math.min(1, pull / 30)),
                    transition: dragging ? 'none' : 'margin-top 0.2s ease-out, opacity 0.2s ease-out',
                }}>
                    <div style={{
                        width: 16, height: 16, borderRadius: '50%',
                        border: '2px solid var(--cr-border)',
                        borderTopColor: progress >= 1 || refreshing ? 'var(--cr-accent)' : 'var(--cr-muted)',
                        transform: refreshing ? undefined : `rotate(${progress * 300}deg)`,
                        animation: refreshing ? 'crewSpin 0.7s linear infinite' : undefined,
                    }} />
                </div>
            </div>
            <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
                {children}
            </div>
        </div>
    )
}
