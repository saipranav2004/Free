import { Link } from 'react-router-dom'
import { KeyRound, Video, Trash2, ExternalLink, KeySquare } from 'lucide-react'
import { DataTable, Th, SortTh, Tr, Td, Trunc, RowActions } from '../ui/grid'
import { RowMenu, MenuItem, MenuLabel } from '../ui/menu'
import { StatusDot, Meta } from '../ui/bits'
import { ResourceTypeIcon } from './ResourceTypeIcon'
import { resourceTypeLabel } from './ResourceCard'

// ---------------------------------------------------------------------------
// Resources grid
// ---------------------------------------------------------------------------
// Rebuilt against the measured rules in design/08-table-craft.md rather than
// against the previous build or against the mockup, both of which got parts of
// this wrong.
//
// COLUMNS ARE ORDERED BY IMPORTANCE, LEFT TO RIGHT, and sized to their
// content, so the identity column is the only one that ever truncates.
//
// HOST CARRIES THE PORT, and this is a correction after seeing it with real
// data. Host and port as separate columns cost 320px between them and left
// the resource name truncating at 240px, which is the wrong trade: the name
// is the thing people scan for and the port is only ever read together with
// the host anyway. `pg-prod-01.internal:5432` is how anyone would write it.
// Port survives as an optional column in preferences for the rare case where
// somebody wants to sort by it.
//
// CONTROLS IS ONE COLUMN, NOT THREE. "Requires JIT" and "always recorded" were
// heading for a status column each, and a table with a populated dot in three
// consecutive columns is 27 dots on screen competing with the data. They are
// two independent flags on the same subject, so they share a cell as small
// labelled glyphs and read as a set.
//
// EVERY ROW CARRIES ITS REAL PRIMARY ACTION. This is the difference between a
// list and a console: the thing you came to do is on the row. Connect and
// Request access both resolve to real endpoints; when neither is possible the
// slot says why instead of offering a button that would fail.

export const RESOURCE_COLUMNS = [
  { key: 'name', label: 'Resource', required: true },
  { key: 'resource_type', label: 'Type' },
  { key: 'host', label: 'Host' },
  { key: 'port', label: 'Port', defaultHidden: true },
  { key: 'controls', label: 'Controls' },
  { key: 'credential', label: 'Credential' },
]

/**
 * The row's primary action, and it is never a lie.
 *
 * - inactive resource      no action exists, the row says why
 * - JIT gated, no grant    Request access, which opens the real JIT modal
 * - otherwise              Connect, which opens the connect panel that calls
 *                          GET /pam/resources/:id/connect-info
 */
// THE ROW ACTION IS A LINK, NOT A FILLED BUTTON, and that is a correction to
// the first attempt at this table. Nine filled blue buttons down the right
// edge is a blue stripe, and a stripe carries no information because every row
// has one. It is the same mistake as six red buttons on a list of healthy
// sessions. Cloudscape allows in-context actions in a cell but treats them as
// secondary; the filled button is reserved for the one primary action on the
// page, which here is Register resource.
function RowAction({ resource, onConnect, onRequestAccess }) {
  if (!resource.is_active) return <Meta>Inactive</Meta>

  const [label, handler] = resource.requires_jit
    ? ['Request access', onRequestAccess]
    : ['Connect', onConnect]

  return (
    <button
      type="button"
      onClick={() => handler(resource)}
      className="whitespace-nowrap rounded px-1 py-0.5 text-sm font-semibold text-accent transition-colors hover:text-accent-hover hover:underline"
    >
      {label}
    </button>
  )
}

export function ResourceTable({
  rows,
  sort,
  onSort,
  visibleColumns,
  onPeek,
  onConnect,
  onRequestAccess,
  onStoreCredential,
  onDelete,
  isAdmin,
  focusedId,
}) {
  const show = (key) => !visibleColumns || visibleColumns.includes(key)

  return (
    <DataTable minWidth="60rem">
      {/* Budgeted to fit a 1130px panel with nothing clipped and no header
          truncated: 272 + 144 + 272 + 120 + 136 + 176 = 1120. Below the
          minWidth the container scrolls and the identity column freezes. */}
      <colgroup>
        {show('name') && <col className="w-[17rem] min-w-[13rem]" />}
        {show('resource_type') && <col className="w-[9rem]" />}
        {show('host') && <col className="w-[17rem]" />}
        {show('port') && <col className="w-[5.5rem]" />}
        {show('controls') && <col className="w-[7.5rem]" />}
        {show('credential') && <col className="w-[8.5rem]" />}
        <col className="w-[11rem]" />
      </colgroup>

      <thead>
        <tr>
          {show('name') && (
            <SortTh columnKey="name" sort={sort} onSort={onSort} sticky edge>
              Resource
            </SortTh>
          )}
          {show('resource_type') && (
            <SortTh columnKey="resource_type" sort={sort} onSort={onSort}>
              Type
            </SortTh>
          )}
          {show('host') && (
            <SortTh columnKey="host" sort={sort} onSort={onSort}>
              Host
            </SortTh>
          )}
          {/* A port is a quantity, so it is right aligned and so is its
              header. Mismatched header alignment is one of the named
              anti-patterns: it opens a gap that reads as a mistake. */}
          {show('port') && (
            <SortTh columnKey="port" sort={sort} onSort={onSort} align="right">
              Port
            </SortTh>
          )}
          {show('controls') && <Th>Controls</Th>}
          {show('credential') && (
            <SortTh columnKey="vault_entry_id" sort={sort} onSort={onSort}>
              Credential
            </SortTh>
          )}
          <Th align="right">
            <span className="sr-only">Actions</span>
          </Th>
        </tr>
      </thead>

      <tbody>
        {rows.map((r) => (
          // The whole row opens the same peek panel the name button does, so
          // the click target matches the band that looks clickable. The name
          // button keeps working on its own; Tr steps aside for it.
          <Tr
            key={r.id}
            onClick={() => onPeek(r)}
            className={focusedId === r.id ? 'ring-1 ring-inset ring-accent/40' : undefined}
          >
            {show('name') && (
              <Td sticky edge>
                <div className="flex min-w-0 items-center gap-2.5">
                  <ResourceTypeIcon type={r.resource_type} className="h-4 w-4 flex-none text-tertiary" />
                  <button
                    type="button"
                    onClick={() => onPeek(r)}
                    title={r.name}
                    className="min-w-0 truncate text-sm font-medium text-primary transition-colors hover:text-accent"
                  >
                    {r.name}
                  </button>
                  {!r.is_active && <Meta>inactive</Meta>}
                </div>
              </Td>
            )}
            {show('resource_type') && (
              <Td>
                <Trunc value={resourceTypeLabel(r.resource_type)} muted />
              </Td>
            )}
            {show('host') && (
              <Td>
                <Trunc
                  value={r.port ? `${r.host}:${r.port}` : r.host}
                  title={r.database_name ? `${r.host}:${r.port} (${r.database_name})` : undefined}
                  mono
                />
              </Td>
            )}
            {show('port') && (
              <Td align="right">
                <span className="font-mono text-xs text-secondary">{r.port || '-'}</span>
              </Td>
            )}
            {show('controls') && (
              <Td>
                <span className="flex items-center gap-3">
                  {r.requires_jit && (
                    <span
                      className="inline-flex items-center gap-1 text-xs text-warn"
                      title="Needs an approved just in time request before you can connect"
                    >
                      <KeyRound className="h-3.5 w-3.5" strokeWidth={1.75} /> JIT
                    </span>
                  )}
                  {(r.always_record || r.recording_required) && (
                    <span
                      className="inline-flex items-center gap-1 text-xs text-secondary"
                      title="Every session on this resource is recorded"
                    >
                      <Video className="h-3.5 w-3.5" strokeWidth={1.75} /> Rec
                    </span>
                  )}
                  {!r.requires_jit && !r.always_record && !r.recording_required && <Meta>none</Meta>}
                </span>
              </Td>
            )}
            {show('credential') && (
              <Td>
                {r.vault_entry_id ? (
                  <StatusDot tone="ok" label="Stored" />
                ) : (
                  <StatusDot tone="warn" label="Missing" title="No credential is stored for this resource" />
                )}
              </Td>
            )}
            <Td align="right">
              <RowActions>
                <RowAction resource={r} onConnect={onConnect} onRequestAccess={onRequestAccess} />
                <RowMenu label={`Actions for ${r.name}`}>
                  <MenuItem icon={ExternalLink}>
                    <Link to={`/resources/${r.id}`} className="block">
                      Open resource
                    </Link>
                  </MenuItem>
                  {isAdmin && (
                    <>
                      <MenuLabel>Administration</MenuLabel>
                      <MenuItem icon={KeySquare} onClick={() => onStoreCredential(r)}>
                        {r.vault_entry_id ? 'Replace credential' : 'Store a credential'}
                      </MenuItem>
                      <MenuItem icon={Trash2} danger onClick={() => onDelete(r)}>
                        Delete resource
                      </MenuItem>
                    </>
                  )}
                </RowMenu>
              </RowActions>
            </Td>
          </Tr>
        ))}
      </tbody>
    </DataTable>
  )
}
