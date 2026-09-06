import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import './styles/global.css'
import App from './App.tsx'
import { TabsProvider } from './contexts/TabsContext'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <TabsProvider>
        <App />
      </TabsProvider>
    </BrowserRouter>
  </StrictMode>,
)
