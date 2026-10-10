import { Navigate, useParams } from 'react-router-dom'
import { normalizeTableLabel } from '../../lib/validation'
import { setCurrentTable } from '../../state/device'

/** Landing route for printed table QR codes: /t/T12 */
export function TableEntry() {
  const { label } = useParams()
  // Idempotent write before redirecting, so the menu sees the table on first render.
  setCurrentTable(normalizeTableLabel(label))
  return <Navigate to="/" replace />
}
