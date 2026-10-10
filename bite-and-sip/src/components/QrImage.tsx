import QRCode from 'qrcode'
import { useEffect, useState } from 'react'

/** Renders a QR code as an image (generated locally — nothing is sent anywhere). */
export function QrImage({ text, size = 220, alt, className = '' }: { text: string; size?: number; alt: string; className?: string }) {
  const [src, setSrc] = useState<string | null>(null)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    let cancelled = false
    QRCode.toDataURL(text, { width: size * 2, margin: 1, errorCorrectionLevel: 'M', color: { dark: '#111111', light: '#FFFFFF' } })
      .then((url) => {
        if (!cancelled) setSrc(url)
      })
      .catch(() => {
        if (!cancelled) setFailed(true)
      })
    return () => {
      cancelled = true
    }
  }, [text, size])

  if (failed) return <p className="text-sm text-danger">Couldn’t draw the QR code.</p>
  return src ? (
    <img src={src} width={size} height={size} alt={alt} className={className} />
  ) : (
    <span className={`block animate-pulse rounded-lg bg-sunken ${className}`} style={{ width: size, height: size }} aria-hidden="true" />
  )
}
