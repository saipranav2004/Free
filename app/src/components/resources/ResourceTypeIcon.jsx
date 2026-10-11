import {
  Database,
  Layers,
  Zap,
  Archive,
  Search as SearchIcon,
  BarChart3,
  Activity,
  Globe,
  Boxes,
} from 'lucide-react'

const ICONS = {
  postgresql: { Icon: Database, className: 'text-blue-600 dark:text-blue-400' },
  mongodb: { Icon: Layers, className: 'text-emerald-600 dark:text-emerald-400' },
  redis: { Icon: Zap, className: 'text-red-600 dark:text-red-400' },
  clickhouse: { Icon: Activity, className: 'text-amber-600 dark:text-amber-400' },
  minio: { Icon: Archive, className: 'text-orange-600 dark:text-orange-400' },
  qdrant: { Icon: SearchIcon, className: 'text-purple-600 dark:text-purple-400' },
  metabase: { Icon: BarChart3, className: 'text-yellow-600 dark:text-yellow-400' },
  langfuse: { Icon: Activity, className: 'text-pink-600 dark:text-pink-400' },
  web: { Icon: Globe, className: 'text-sky-600 dark:text-sky-400' },
  oracle: { Icon: Database, className: 'text-red-600 dark:text-red-500' },
}

export function ResourceTypeIcon({ type, className = 'h-4 w-4' }) {
  const entry = ICONS[type] || { Icon: Boxes, className: 'text-ink-400' }
  const { Icon, className: colorClass } = entry
  // strokeWidth 1.5 across the app's iconography, a thinner stroke is what
  // separates a technical enterprise icon set from a generic UI one.
  return <Icon className={`${className} ${colorClass}`} strokeWidth={1.5} />
}
