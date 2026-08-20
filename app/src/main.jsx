import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { BrowserRouter } from 'react-router-dom'
import { Toaster } from 'sonner'
import App from './App.jsx'
import { ErrorBoundary } from './components/common/ErrorBoundary'
import { DensityProvider } from './components/ui/grid'
import { useThemeStore } from './store/themeStore'
import './index.css'

// Bridges the theme store to sonner's own theme prop so toasts match
// whichever mode (light/dark/system-resolved) the rest of the app is in,
// instead of being hardcoded to always look like a dark-mode toast on a
// light-mode page.
function ThemedToaster() {
  const isDark = useThemeStore((s) => s.isDark)
  return <Toaster theme={isDark ? 'dark' : 'light'} position="top-right" richColors closeButton />
}

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // A privileged-access console should not silently retry a failed
      // fetch 3 times with exponential backoff by default (react-query's
      // out-of-the-box behavior), that turns one 403 into 4 network calls
      // and delays the error the user actually needs to see. Retry once,
      // fast, for transient blips; anything that fails twice is shown.
      retry: 1,
      refetchOnWindowFocus: false,
      staleTime: 10_000,
    },
    mutations: {
      retry: 0, // never auto-retry a POST/write, could double-submit a real action
    },
  },
})

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <ErrorBoundary>
      <QueryClientProvider client={queryClient}>
        {/* Opt in to the v7 behaviours now. Both are already how this app
            expects to behave, and leaving them off meant every page load
            logged two upgrade warnings to the console, which is noise that
            hides real ones. */}
        <BrowserRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
          {/* Row density is one preference for the whole console, persisted,
              not a per page control that forgets itself on navigation. */}
          <DensityProvider>
            <App />
          </DensityProvider>
        </BrowserRouter>
        <ThemedToaster />
      </QueryClientProvider>
    </ErrorBoundary>
  </StrictMode>
)
