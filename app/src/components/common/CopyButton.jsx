import { useEffect, useRef, useState } from 'react'
import { Check, Copy } from 'lucide-react'
import { Button } from './Button'

// navigator.clipboard.writeText() requires a secure context (HTTPS or
// localhost) and can reject silently in some embedded/iframe contexts ,
// both handled here so a copy failure shows a clear fallback instead of
// just doing nothing when clicked (a real, reported class of bug: users
// clicking "Copy" repeatedly assuming they mis-clicked).
export function CopyButton({ value, label = 'Copy' }) {
  const [copied, setCopied] = useState(false)
  const [failed, setFailed] = useState(false)
  const timeoutRef = useRef(null)

  // Clear the pending "copied" reset timer on unmount so it doesn't call
  // setState on an unmounted component (React warns about this, and it's a
  // real memory-leak-shaped bug in a modal that can close before 1.5s pass).
  useEffect(() => () => clearTimeout(timeoutRef.current), [])

  const handleClick = async () => {
    setFailed(false)
    try {
      if (!navigator.clipboard) throw new Error('clipboard API unavailable')
      await navigator.clipboard.writeText(value)
      setCopied(true)
      timeoutRef.current = setTimeout(() => setCopied(false), 1500)
    } catch {
      setFailed(true)
      timeoutRef.current = setTimeout(() => setFailed(false), 2000)
    }
  }

  if (failed) {
    return (
      <span className="inline-flex h-8 items-center rounded-md bg-red-50 px-2.5 text-xs font-medium text-red-700 ring-1 ring-inset ring-red-600/20 dark:bg-red-950/40 dark:text-red-300 dark:ring-red-500/30">
        Copy failed, select manually
      </span>
    )
  }

  return (
    <Button
      type="button"
      size="sm"
      variant="secondary"
      icon={copied ? Check : Copy}
      onClick={handleClick}
      className={copied ? 'text-emerald-700 dark:text-emerald-300' : undefined}
    >
      {copied ? 'Copied' : label}
    </Button>
  )
}
