import { Component } from 'react'
import { AlertTriangle, RotateCcw } from 'lucide-react'

// A single bad render anywhere in the tree (a null-deref on an unexpected
// API shape, a third-party component throwing, whatever) should never take
// down the entire console with a blank white screen, that's the single
// worst possible failure mode for a tool people use to manage privileged
// access. This is the backstop.
//
// Deliberately class-based: error boundaries are not expressible as hooks
// (no useErrorBoundary equivalent exists in React 18), this is the one
// legitimate reason for a class component in an otherwise all-function
// codebase.
export class ErrorBoundary extends Component {
  constructor(props) {
    super(props)
    this.state = { error: null }
  }

  static getDerivedStateFromError(error) {
    return { error }
  }

  componentDidCatch(error, info) {
    // In a real deployment this is where you'd forward to Sentry/similar.
    // eslint-disable-next-line no-console
    console.error('[ErrorBoundary] caught render error:', error, info)
  }

  reset = () => this.setState({ error: null })

  render() {
    if (this.state.error) {
      return (
        <div className="flex min-h-[60vh] items-center justify-center p-8">
          <div className="w-full max-w-lg rounded-xl border border-surface-700 bg-surface-900 p-8 text-center ">
            <div className="mx-auto mb-5 flex h-12 w-12 items-center justify-center rounded-xl bg-amber-50 text-amber-600 ring-1 ring-inset ring-amber-600/15 dark:bg-amber-500/10 dark:text-amber-300 dark:ring-amber-500/25">
              <AlertTriangle className="h-5 w-5" strokeWidth={1.75} />
            </div>
            <h2 className="text-base font-semibold text-ink-50">Something went wrong</h2>
            <p className="mx-auto mt-2 max-w-md text-sm leading-relaxed text-ink-400">
              This section hit an unexpected error and couldn&apos;t render. The rest of the console is
              unaffected, try again, or navigate elsewhere.
            </p>
            {import.meta.env.DEV && (
              <pre className="mt-5 max-h-52 max-w-full overflow-auto rounded-lg border border-surface-700 bg-surface-950 p-3 text-left font-mono text-xs leading-relaxed text-red-700 dark:text-red-300">
                {String(this.state.error?.stack || this.state.error)}
              </pre>
            )}
            <button
              onClick={this.reset}
              className="mt-6 inline-flex h-9 items-center gap-2 rounded-lg bg-blue-600 px-4 text-sm font-medium text-white shadow-sm ring-1 ring-inset ring-blue-500/50 transition-colors hover:bg-blue-500 active:bg-blue-700"
            >
              <RotateCcw className="h-4 w-4" strokeWidth={2} /> Try again
            </button>
          </div>
        </div>
      )
    }
    return this.props.children
  }
}
