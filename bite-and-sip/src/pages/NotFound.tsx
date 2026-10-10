import { Link } from 'react-router-dom'
import { EmptyState } from '../components/ui'

export function NotFound() {
  return (
    <main className="mx-auto max-w-md pt-16">
      <EmptyState title="Page not found" action={<Link to="/" className="font-bold underline underline-offset-4">Go to the menu</Link>}>
        The link may be old or mistyped.
      </EmptyState>
    </main>
  )
}
