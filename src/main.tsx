import "@/lib/logger";
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router'
import './index.css'
import { TRPCProvider } from "@/providers/trpc"
import App from './App.tsx'
import { initialLanguage, setLanguage } from '@/i18n'
import { loadSettings } from '@/lib/storage'

// Словарь выбранного языка грузим до первого рендера — без мигания английским.
// Если чанк не загрузился, остаёмся на английском.
void setLanguage(initialLanguage(loadSettings().uiLang))
  .catch(() => undefined)
  .then(() => {
    createRoot(document.getElementById('root')!).render(
      <StrictMode>
        <BrowserRouter>
          <TRPCProvider>
            <App />
          </TRPCProvider>
        </BrowserRouter>
      </StrictMode>,
    )
  })
