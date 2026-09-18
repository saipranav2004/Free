import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { BrowserRouter } from 'react-router-dom'
import { Toaster } from 'sonner'
import { CheckCircle2, AlertTriangle, Info, XCircle, Loader2 } from 'lucide-react'
import App from './App.jsx'
import { ErrorBoundary } from './components/common/ErrorBoundary'
import { DensityProvider } from './components/ui/grid'
import { useThemeStore } from './store/themeStore'
import { useAuthStore } from './store/authStore'
import { installDevtoolsGuard } from './lib/devtoolsGuard'
import { reportDevToolsDetected } from './api/clientGuard'
import { DEVTOOLS_GUARD } from './config/constants'
import './index.css'

// Bridges the theme store to sonner's own theme prop so toasts match whichever
// mode the rest of the app is in.
//
// richColors is OFF on purpose. It paints a bright, saturated background per
// toast type, which is the notification equivalent of a filled status pill on
// every row: it shouts at a palette that whispers, and a page of muted greys
// with one neon-green success banner reads as a different product for the two
// seconds it is on screen. The toast is a neutral surface (panel, hairline,
// soft shadow, themed in index.css) with ONE coloured mark: the outcome icon.
// That is how AWS, Linear and Stripe do a toast, and it is the same rule the
// rest of this console follows, colour signals state, never decoration.
const ICON = { className: 'h-[1.15rem] w-[1.15rem] flex-none' }
function ThemedToaster() {
  const isDark = useThemeStore((s) => s.isDark)
  return (
    <Toaster
      theme={isDark ? 'dark' : 'light'}
      position="top-right"
      closeButton
      gap={10}
      offset={16}
      duration={5000}
      icons={{
        success: <CheckCircle2 {...ICON} strokeWidth={2} style={{ color: 'rgb(var(--ok))' }} />,
        error: <XCircle {...ICON} strokeWidth={2} style={{ color: 'rgb(var(--danger))' }} />,
        warning: <AlertTriangle {...ICON} strokeWidth={2} style={{ color: 'rgb(var(--warn))' }} />,
        info: <Info {...ICON} strokeWidth={2} style={{ color: 'rgb(var(--accent))' }} />,
        loading: <Loader2 {...ICON} strokeWidth={2} className="h-[1.15rem] w-[1.15rem] flex-none animate-spin" style={{ color: 'rgb(var(--text-tertiary))' }} />,
      }}
    />
  )
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

// ---------------------------------------------------------------------------
// Developer Tools guard
// ---------------------------------------------------------------------------
// Installed BEFORE the first render, on purpose: the whole point is to be the
// first thing running on the page. It is a DETERRENT, not a security boundary
// (see src/lib/devtoolsGuard.js for what that means and why), and it is off
// unless VITE_DEVTOOLS_GUARD says otherwise.
//
// isProtected keeps it dormant until there is a real session to protect, so the
// sign-in and MFA screens are never wiped. An operator who cannot sign in and
// cannot see why has no way to report the problem.
let appRoot = null

installDevtoolsGuard({
  enabled: DEVTOOLS_GUARD.enabled,
  dockedDeltaPx: DEVTOOLS_GUARD.dockedDeltaPx,
  debuggerPauseMs: DEVTOOLS_GUARD.debuggerPauseMs,
  checkIntervalMs: DEVTOOLS_GUARD.checkIntervalMs,
  recoveryIntervalMs: DEVTOOLS_GUARD.recoveryIntervalMs,
  confirmTicks: DEVTOOLS_GUARD.confirmTicks,
  isProtected: () => Boolean(useAuthStore.getState().accessToken),
  report: reportDevToolsDetected,
  // Shut the app down before the guard removes the document. Unmounting first
  // stops React rendering into a mount point that is about to disappear, and
  // cancelling the query cache stops react-query issuing further requests,
  // which is what "stop the page from loading" has to mean for an SPA: the
  // fetches keep going otherwise, wiped DOM or not.
  onDetect: () => {
    try {
      queryClient.cancelQueries()
      queryClient.clear()
    } catch {
      // Nothing here may keep the block from being drawn.
    }
    try {
      if (appRoot) appRoot.unmount()
    } catch {
      // Same.
    }
  },
})

appRoot = createRoot(document.getElementById('root'))
appRoot.render(
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
