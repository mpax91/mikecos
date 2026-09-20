import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import { registerSW } from 'virtual:pwa-register'
import './styles/global.css'
import App from './App.tsx'
import { TabsProvider } from './contexts/TabsContext'

// `immediate: true` checks for a new service worker as soon as the app
// loads (not just on the next visit); combined with registerType:
// 'autoUpdate' and the skipWaiting/clientsClaim workbox options in
// vite.config.ts, a newly deployed build takes over and reloads this tab on
// its own instead of silently sitting there until every tab is closed.
registerSW({ immediate: true })

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <TabsProvider>
        <App />
      </TabsProvider>
    </BrowserRouter>
  </StrictMode>,
)
