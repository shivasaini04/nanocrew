import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import './index.css'
import './lib/fetchInterceptor' // installs global 401 → login handler (side effect)
import './stores/themeStore' // syncs data-theme + follows OS changes (side effect)
import App from './App'
import { ErrorBoundary } from './components/ErrorBoundary'

// After a deploy, a browser holding the OLD index.html requests stale chunk hashes →
// lazy imports 404 ("Failed to fetch dynamically imported module"). Reload once (rate-
// limited) to pull the fresh index.html + chunks instead of showing an error screen.
window.addEventListener('vite:preloadError', () => {
  const k = 'nc-chunk-reload-at'
  const last = Number(sessionStorage.getItem(k) || 0)
  if (Date.now() - last > 10000) {
    sessionStorage.setItem(k, String(Date.now()))
    window.location.reload()
  }
})

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary>
      <BrowserRouter>
        <App />
      </BrowserRouter>
    </ErrorBoundary>
  </StrictMode>,
)
