import { useEffect, useState } from 'react'

/** True when the viewport is narrower than `breakpoint`px. Updates live on resize/rotate. */
export function useIsMobile(breakpoint = 860): boolean {
    const query = `(max-width: ${breakpoint}px)`
    const [isMobile, setIsMobile] = useState(() => window.matchMedia(query).matches)

    useEffect(() => {
        const mql = window.matchMedia(query)
        const onChange = () => setIsMobile(mql.matches)
        mql.addEventListener('change', onChange)
        return () => mql.removeEventListener('change', onChange)
    }, [query])

    return isMobile
}
