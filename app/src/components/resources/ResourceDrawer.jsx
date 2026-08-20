import { Link, useNavigate } from 'react-router-dom'
import { ExternalLink, Maximize2 } from 'lucide-react'
import { toast } from 'sonner'
import { Drawer } from '../common/Drawer'
import { buttonClass } from '../common/Button'
import { DetailList } from '../common/Layout'
import { ResourceTypeIcon } from './ResourceTypeIcon'
import { OpenInDesktopButton } from './ResourceAccess'
import { ResourceStatusBadges, CredentialState, resourceTypeLabel } from './ResourceCard'
import { CONNECT_MODES } from '../../config/constants'

const CONNECT_MODE_LABEL = Object.fromEntries(
  CONNECT_MODES.map((m) => [m.value, m.label.replace(/\s*\(.*\)$/, '')])
)

// Peek panel. Renders the row the list already has, it issues NO request of
// its own, so opening a drawer costs nothing and can't show a different
// answer than the row you clicked. Anything that needs live state (connect
// info, credential rotation, audit) lives on the full detail page, one click
// away in the footer.
export function ResourceDrawer({ resource, open, onClose }) {
  const navigate = useNavigate()
  if (!resource) return null

  return (
    <Drawer
      open={open}
      onClose={onClose}
      title={resource.name}
      subtitle={`${resource.host}:${resource.port}`}
      icon={<ResourceTypeIcon type={resource.resource_type} className="h-[1.15rem] w-[1.15rem]" />}
      footer={
        <>
          {/* Was a "Connect" link that only navigated to the detail page and
 left you to find the launcher. This is the real hand-off: same
 mutation the detail page's header button runs. A 409 ("no device
 paired") is the one case the drawer can't host, the pairing
 panel doesn't fit here, so it sends you to the page that does. */}
          <OpenInDesktopButton
            resourceId={resource.id}
            size="sm"
            onNeedsPairing={() => {
              toast.info('Pair this browser with the desktop agent to continue')
              onClose?.()
              navigate(`/resources/${resource.id}`)
            }}
          />
          <Link
            to={`/resources/${resource.id}`}
            className={buttonClass({ variant: 'secondary', size: 'sm' })}
          >
            <Maximize2 className="h-3.5 w-3.5 flex-none" strokeWidth={2} />
            Open full page
          </Link>
        </>
      }
    >
      <div className="px-5 py-4">
        <ResourceStatusBadges resource={resource} />
        {resource.description && (
          <p className="mt-4 text-sm leading-relaxed text-ink-300">{resource.description}</p>
        )}
      </div>

      <div className="border-t border-surface-800">
        <p className="px-5 pb-1 pt-4 text-xs font-semibold text-ink-500">Connection</p>
        <DetailList
          items={[
            { label: 'Type', value: resourceTypeLabel(resource.resource_type) },
            { label: 'Host', value: <span className="font-mono text-xs">{resource.host}</span> },
            { label: 'Port', value: <span className="font-mono text-xs tabular-nums">{resource.port}</span> },
            { label: 'Database', value: resource.database_name || '-' },
            {
              label: 'Connect mode',
              value: CONNECT_MODE_LABEL[resource.connect_mode] || resource.connect_mode || '-',
            },
            {
              label: 'Console URL',
              value: resource.console_url ? (
                <a
                  href={resource.console_url}
                  target="_blank"
                  rel="noreferrer noopener"
                  className="inline-flex items-center gap-1.5 break-all text-blue-600 hover:text-blue-500 dark:text-blue-400 dark:hover:text-blue-300"
                >
                  {resource.console_url}
                  <ExternalLink className="h-3 w-3 flex-none" strokeWidth={2} />
                </a>
              ) : (
                '-'
              ),
            },
          ]}
        />
      </div>

      <div className="border-t border-surface-800">
        <p className="px-5 pb-1 pt-4 text-xs font-semibold text-ink-500">Access & policy</p>
        <DetailList
          items={[
            { label: 'Group', value: resource.group || '-' },
            {
              label: 'Elevation',
              value: resource.requires_jit ? 'Approved JIT request required' : 'Standing access',
            },
            { label: 'Recording', value: resource.always_record ? 'Always recorded' : 'Per session policy' },
            { label: 'Credential', value: <CredentialState resource={resource} /> },
          ]}
        />
      </div>
    </Drawer>
  )
}
