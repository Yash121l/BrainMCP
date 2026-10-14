import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'

import './index.css'
import { initAnalytics } from './lib/analytics'

initAnalytics()

// Dark unless the OS asks for light; follow changes live.
const light = window.matchMedia('(prefers-color-scheme: light)')
const applyTheme = () => {
  document.documentElement.classList.toggle('dark', !light.matches)
  document.documentElement.style.colorScheme = light.matches ? 'light' : 'dark'
}
applyTheme()
light.addEventListener('change', applyTheme)
import App from './App.tsx'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
