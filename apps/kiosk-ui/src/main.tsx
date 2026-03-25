import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import AdminPage from './AdminPage.tsx'
import DebugPage from './DebugPage.tsx'

const isAdminRoute = window.location.pathname === '/admin'
const isDebugRoute = window.location.pathname === '/debug'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {isAdminRoute ? <AdminPage /> : isDebugRoute ? <DebugPage /> : <App />}
  </StrictMode>,
)
