import { Compass } from 'lucide-react'
import { Button } from '../components/common/Button'

// A 404 lands on the same plate every other empty or error state uses, so a
// missing page reads as one of the console's own states rather than as a
// different screen. The message covers the two real causes, a bad address, or
// a route the account can no longer reach, and offers the one way back.
export default function NotFoundPage() {
  return (
    <div className="flex min-h-[60vh] flex-col items-center justify-center px-6 text-center">
      <span className="mb-5 flex h-12 w-12 items-center justify-center rounded-xl bg-subtle text-tertiary">
        <Compass className="h-6 w-6" strokeWidth={1.5} />
      </span>
      <p className="text-sm font-semibold text-tertiary">Error 404</p>
      <h1 className="mt-2 text-2xl font-bold text-primary">Page not found</h1>
      <p className="mt-2 max-w-md text-sm leading-relaxed text-secondary">
        This route does not exist, or your account no longer has access to it. Check the address, or head
        back to the dashboard.
      </p>
      <div className="mt-6">
        <Button variant="primary" to="/">
          Back to the dashboard
        </Button>
      </div>
    </div>
  )
}
