import { useLocation } from 'react-router-dom'
import { useAppStore } from '../stores/appStore'

const pageTitles: Record<string, string> = {
    '/': 'Overview',
    '/containers': 'Containers',
    '/memory': 'Memory & Skills',
    '/settings': 'Settings',
}

export default function TopBar() {
    const location = useLocation()
    const { connectionStatus } = useAppStore()
    const title = pageTitles[location.pathname] || 'nanocrew'

    return (
        <div className="topbar">
            <div className="topbar-left">
                <h1 className="topbar-title">{title}</h1>
            </div>
            <div className="topbar-right">
                <div className={`status-badge ${connectionStatus}`}>
                    <span className="status-dot" />
                    {connectionStatus === 'online' ? 'Connected' : 'Disconnected'}
                </div>
            </div>
        </div>
    )
}
