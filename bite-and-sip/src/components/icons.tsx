import type { SVGProps } from 'react'

type IconProps = SVGProps<SVGSVGElement> & { size?: number }

function base({ size = 20, ...rest }: IconProps) {
  return {
    width: size,
    height: size,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 2,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    'aria-hidden': true,
    focusable: false,
    ...rest,
  }
}

export const IconSearch = (p: IconProps) => (
  <svg {...base(p)}><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></svg>
)
export const IconPlus = (p: IconProps) => (
  <svg {...base(p)}><path d="M12 5v14M5 12h14" /></svg>
)
export const IconMinus = (p: IconProps) => (
  <svg {...base(p)}><path d="M5 12h14" /></svg>
)
export const IconX = (p: IconProps) => (
  <svg {...base(p)}><path d="M18 6 6 18M6 6l12 12" /></svg>
)
export const IconCheck = (p: IconProps) => (
  <svg {...base(p)}><path d="m5 12 5 5L20 7" /></svg>
)
export const IconArrowLeft = (p: IconProps) => (
  <svg {...base(p)}><path d="M19 12H5M12 19l-7-7 7-7" /></svg>
)
export const IconArrowRight = (p: IconProps) => (
  <svg {...base(p)}><path d="M5 12h14M12 5l7 7-7 7" /></svg>
)
export const IconChevronRight = (p: IconProps) => (
  <svg {...base(p)}><path d="m9 18 6-6-6-6" /></svg>
)
export const IconBag = (p: IconProps) => (
  <svg {...base(p)}><path d="M6 7h12l1 13H5L6 7Z" /><path d="M9 7a3 3 0 0 1 6 0" /></svg>
)
export const IconClock = (p: IconProps) => (
  <svg {...base(p)}><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></svg>
)
export const IconPin = (p: IconProps) => (
  <svg {...base(p)}><path d="M12 21s7-6.1 7-12a7 7 0 1 0-14 0c0 5.9 7 12 7 12Z" /><circle cx="12" cy="9" r="2.5" /></svg>
)
export const IconTrash = (p: IconProps) => (
  <svg {...base(p)}><path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3" /></svg>
)
export const IconEdit = (p: IconProps) => (
  <svg {...base(p)}><path d="M4 20h4L19 9l-4-4L4 16v4Z" /><path d="m13.5 6.5 4 4" /></svg>
)
export const IconCopy = (p: IconProps) => (
  <svg {...base(p)}><rect x="9" y="9" width="11" height="11" rx="2" /><path d="M5 15V5a2 2 0 0 1 2-2h8" /></svg>
)
export const IconRefresh = (p: IconProps) => (
  <svg {...base(p)}><path d="M20 11a8 8 0 1 0-2.3 5.7" /><path d="M20 4v7h-7" /></svg>
)
export const IconWifiOff = (p: IconProps) => (
  <svg {...base(p)}><path d="m2 2 20 20M8.5 16.5a5 5 0 0 1 7 0M5 13a10 10 0 0 1 5.2-2.8M19 13a10 10 0 0 0-2-1.5M2 9a15 15 0 0 1 4.7-2.9M22 9a15 15 0 0 0-9.6-3.8" /><circle cx="12" cy="20" r="0.5" /></svg>
)
export const IconBell = (p: IconProps) => (
  <svg {...base(p)}><path d="M6 8a6 6 0 1 1 12 0c0 7 3 9 3 9H3s3-2 3-9" /><path d="M10.3 21a1.9 1.9 0 0 0 3.4 0" /></svg>
)
export const IconBellOff = (p: IconProps) => (
  <svg {...base(p)}><path d="m2 2 20 20M8.7 3A6 6 0 0 1 18 8c0 2.6.4 4.6 1 6M17 17H3s3-2 3-9c0-.7.1-1.4.3-2" /><path d="M10.3 21a1.9 1.9 0 0 0 3.4 0" /></svg>
)
export const IconLogOut = (p: IconProps) => (
  <svg {...base(p)}><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9" /></svg>
)
export const IconPrinter = (p: IconProps) => (
  <svg {...base(p)}><path d="M6 9V3h12v6M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2" /><path d="M6 14h12v7H6z" /></svg>
)
export const IconImage = (p: IconProps) => (
  <svg {...base(p)}><rect x="3" y="3" width="18" height="18" rx="2" /><circle cx="9" cy="9" r="2" /><path d="m21 15-5-5L5 21" /></svg>
)
export const IconReceipt = (p: IconProps) => (
  <svg {...base(p)}><path d="M5 3v18l2.5-1.5L10 21l2-1.5 2 1.5 2.5-1.5L19 21V3l-2.5 1.5L14 3l-2 1.5L10 3 7.5 4.5Z" /><path d="M9 9h6M9 13h6" /></svg>
)
export const IconSettings = (p: IconProps) => (
  <svg {...base(p)}><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1Z" /></svg>
)
export const IconChart = (p: IconProps) => (
  <svg {...base(p)}><path d="M3 3v18h18" /><path d="M7 16v-5M12 16V8M17 16v-8" /></svg>
)
export const IconBoard = (p: IconProps) => (
  <svg {...base(p)}><rect x="3" y="4" width="5" height="16" rx="1.5" /><rect x="10" y="4" width="5" height="11" rx="1.5" /><rect x="17" y="4" width="4" height="7" rx="1.5" /></svg>
)
export const IconMenuBook = (p: IconProps) => (
  <svg {...base(p)}><path d="M4 5a2 2 0 0 1 2-2h13v16H6a2 2 0 0 0-2 2V5Z" /><path d="M4 19a2 2 0 0 1 2-2h13v4H6a2 2 0 0 1-2-2ZM9 7h6M9 11h4" /></svg>
)
export const IconInfo = (p: IconProps) => (
  <svg {...base(p)}><circle cx="12" cy="12" r="9" /><path d="M12 16v-4M12 8h.01" /></svg>
)
export const IconAlert = (p: IconProps) => (
  <svg {...base(p)}><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z" /><path d="M12 9v4M12 17h.01" /></svg>
)
export const IconQr = (p: IconProps) => (
  <svg {...base(p)}><rect x="3" y="3" width="7" height="7" rx="1" /><rect x="14" y="3" width="7" height="7" rx="1" /><rect x="3" y="14" width="7" height="7" rx="1" /><path d="M14 14h3v3h-3zM20 14v.01M14 20h.01M17 20h4v-3" /></svg>
)
export const IconPhone = (p: IconProps) => (
  <svg {...base(p)}><path d="M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.1 4.2 2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1.9.4 1.8.7 2.7a2 2 0 0 1-.5 2.1L8.1 9.8a16 16 0 0 0 6 6l1.3-1.3a2 2 0 0 1 2.1-.4c.9.3 1.8.6 2.7.7a2 2 0 0 1 1.7 2Z" /></svg>
)
export const IconExternal = (p: IconProps) => (
  <svg {...base(p)}><path d="M15 3h6v6M10 14 21 3M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" /></svg>
)
export const IconDownload = (p: IconProps) => (
  <svg {...base(p)}><path d="M12 3v12M7 10l5 5 5-5M5 21h14" /></svg>
)
export const IconStar = (p: IconProps) => (
  <svg {...base({ ...p, fill: 'currentColor', strokeWidth: 0 })}><path d="m12 2.5 2.9 6 6.6.9-4.8 4.6 1.2 6.5L12 17.4l-5.9 3.1 1.2-6.5L2.5 9.4l6.6-.9z" /></svg>
)
