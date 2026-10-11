import { useQuery } from '@tanstack/react-query'
import { Globe, KeyRound, Laptop, Loader2, ShieldAlert, Terminal } from 'lucide-react'
import { getConnectInfo } from '../../api/resources'
import { normalizeApiError } from '../../lib/apiError'
import { MenuItem, MenuLabel } from '../ui/menu'
import { cliCommand, hasCliClient, useDesktopLaunch, useWebSessionLaunch } from './ResourceAccess'

// ---------------------------------------------------------------------------
// The standard user's way into a resource
// ---------------------------------------------------------------------------
// A standard user has no resource detail page. That is not a gap: the detail
// page is a configuration record (credentials, policy bindings, audit,
// delete) and every control on it is admin-gated, so an operator who reached it
// found a screen whose only working action was the one they had just clicked
// from the row. The console redirected them off it, which is why clicking a
// resource looked like it did nothing at all.
//
// So the row's overflow menu IS the resource surface for them, and it carries
// the only three things they came for: open it on their desktop, open it in a
// browser, or get the command for their own client.
//
// WHY THE MENU IS BUILT FROM A REQUEST, NOT FROM THE ROW. Whether a given way
// in actually works depends on facts the catalogue row does not carry: whether
// a credential is stored, whether this user has paired a device, whether the
// brokered web gateway is switched on, and whether they hold a live grant right
// now. GET /pam/resources/:id/connect-info answers all of it in one call and
// returns `available_methods`, which is the server's own list of what will
// work THIS SECOND. Rendering from anything else produces a menu entry whose
// only outcome is an error.
//
// The request is made when the menu opens, not when the page loads: ui/menu.jsx
// renders its children only while open, so mounting this component IS the
// trigger. A catalogue of forty resources therefore costs zero extra requests
// until somebody actually asks about one of them.
//
// Server-side, the same three actions are behind pam:resource:Connect AND
// middleware.RequireActiveGrant. The menu never becomes the boundary; it only
// stops offering doors that are locked.

function StaticItem({ icon: Icon, children, tone }) {
  return (
    <p
      className={
        'flex items-start gap-2 px-3 py-2 text-xs leading-relaxed ' +
        (tone === 'danger' ? 'text-danger' : 'text-secondary')
      }
    >
      {Icon && <Icon className="mt-0.5 h-3.5 w-3.5 flex-none" strokeWidth={1.9} />}
      <span>{children}</span>
    </p>
  )
}

/**
 * The body of a standard user's row menu.
 *
 * @param resource        the catalogue row
 * @param onRequestAccess opens the JIT request modal for this resource
 * @param onOpenCli       hands the resolved connect-info up so the page can
 *                        show the command; the menu itself is too small to
 *                        hold a copyable block
 */
export function ConnectMenuItems({ resource, onRequestAccess, onOpenCli }) {
  const query = useQuery({
    queryKey: ['resources', resource.id, 'connect-info'],
    queryFn: ({ signal }) => getConnectInfo(resource.id, signal),
    retry: false,
    // Short: an approval landing while the menu is shut must not leave a
    // stale "request access" behind the next time it opens.
    staleTime: 10_000,
  })

  const desktop = useDesktopLaunch(resource.id)
  const web = useWebSessionLaunch(resource.id)

  if (!resource.is_active) {
    return <StaticItem icon={ShieldAlert}>This resource is inactive, so there is nothing to open.</StaticItem>
  }

  if (query.isLoading) {
    return (
      <StaticItem icon={Loader2}>Checking what you can open…</StaticItem>
    )
  }

  if (query.isError) {
    const err = normalizeApiError(query.error)
    // The JIT gate is the product working, not a failure, so it gets the one
    // action that resolves it rather than an error line.
    if (err.code === 'jit_grant_required') {
      return (
        <>
          <StaticItem icon={KeyRound}>
            This resource needs time-boxed access and you do not hold a grant right now.
          </StaticItem>
          <MenuItem icon={KeyRound} onClick={() => onRequestAccess(resource)}>
            Request access
          </MenuItem>
        </>
      )
    }
    return (
      <StaticItem icon={ShieldAlert} tone="danger">
        {err.message}
      </StaticItem>
    )
  }

  const info = query.data || {}
  const methods = Array.isArray(info.available_methods) ? info.available_methods : []
  const command = cliCommand(info)

  const canDesktop = methods.includes('native_agent')
  const canBrokerWeb = methods.includes('web_proxy')
  const rawConsole = !canBrokerWeb && methods.includes('web_app') ? info.console_url : null
  // web_terminal is the server saying "this type has a real protocol
  // connector and a credential is filed", which is exactly the precondition
  // for recording a session and handing over the command.
  const canCli = methods.includes('web_terminal') && !!command

  if (!canDesktop && !canBrokerWeb && !rawConsole && !canCli) {
    return (
      <StaticItem icon={ShieldAlert}>
        {info.has_credential
          ? 'No connection method is configured for this resource yet.'
          : 'No credential is stored for this resource, so there is nothing to broker on your behalf.'}
      </StaticItem>
    )
  }

  return (
    <>
      <MenuLabel>Connect</MenuLabel>

      {/* Ordered by how much of the connection PAM brokers. The desktop agent
          carries the credential without ever exposing it, the brokered web
          path keeps PAM in the data flow, and the CLI hand-off records the
          session but leaves the connecting to the operator's own client. */}
      {canDesktop && (
        <MenuItem
          icon={Laptop}
          disabled={desktop.isPending}
          onClick={() => desktop.mutate()}
        >
          Open in Desktop
        </MenuItem>
      )}

      {canBrokerWeb && (
        <MenuItem icon={Globe} disabled={web.isPending} onClick={() => web.mutate()}>
          Open in Web
        </MenuItem>
      )}

      {rawConsole && (
        <MenuItem icon={Globe} onClick={() => window.open(rawConsole, '_blank', 'noopener')}>
          Open in Web
        </MenuItem>
      )}

      {canCli && (
        <MenuItem icon={Terminal} onClick={() => onOpenCli({ resource, info, command })}>
          {hasCliClient(info) ? 'Open in CLI' : 'Show connection details'}
        </MenuItem>
      )}

      {rawConsole && (
        <StaticItem icon={ShieldAlert}>
          This opens the application&apos;s own sign-in page. PAM does not broker or record it.
        </StaticItem>
      )}
    </>
  )
}
