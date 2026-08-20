import { Link } from 'react-router-dom'
import { Compass, ArrowLeft } from 'lucide-react'

export default function NotFoundPage() {
  return (
    <div className="flex min-h-[55vh] flex-col items-center justify-center px-6 text-center">
      <div className="mb-5 flex h-12 w-12 items-center justify-center rounded-xl border border-surface-700 bg-surface-900 text-ink-400 ">
        <Compass className="h-5 w-5" strokeWidth={1.5} />
      </div>
      <p className="text-xs font-semibold text-ink-500">Error 404</p>
      <h1 className="mt-2 text-xl font-semibold tracking-tight text-ink-50">Page not found</h1>
      <p className="mt-2 max-w-sm text-sm leading-relaxed text-ink-400">
        This route doesn&apos;t exist, or you no longer have access to it. Check the address, or head back to
        the dashboard.
      </p>
      <Link
        to="/"
        className="mt-6 inline-flex h-9 items-center gap-2 rounded-lg border border-surface-700 bg-surface-900 px-3.5 text-sm font-medium text-ink-100 transition-colors hover:border-surface-600 hover:bg-surface-850"
      >
        <ArrowLeft className="h-4 w-4" strokeWidth={2} /> Back to dashboard
      </Link>
    </div>
  )
}
