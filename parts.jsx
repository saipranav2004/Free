/**
 * parts.jsx — building blocks for the external identity mapping detail page.
 *
 * Split out of the page for the same reason pam/parts.jsx and m365/parts.jsx
 * are: the page then reads as data flow and layout, and each dialog can be
 * reasoned about on its own.
 *
 * Everything here is provider-agnostic and driven by the descriptor from
 * utils/providers.js — GitHub is passed in, never hard-coded.
 */
import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  AlertTriangle, Check, Clock, Copy, ExternalLink, KeyRound, Link2, Plus, ShieldCheck,
  UserRoundCheck,
} from 'lucide-react';
import { useToast } from '../../../context/ToastContext.jsx';
import { useResource } from '../../../hooks/useResource.js';
import { integrationApi } from '../../../lib/api/integration.js';
import {
  Badge, Button, IconButton, Input, SearchableCombobox, Select, Spinner, StatusBadge,
  Textarea, FormErrorSummary,
} from '../../../components/ui/primitives.jsx';
import { Modal } from '../../../components/ui/Modal.jsx';
import {
  ExpiryInput, fromIsoExpiry, isPastExpiry, toIsoExpiry,
} from '../../../components/ui/ExpiryInput.jsx';
import {
  classNames, formatDateTime, formatRelative, initials,
} from '../../../utils/format.js';
/* Record-shape helpers live in utils/integrations.js so the Resources list and
   this page can never parse the same collection differently. */
import {
  isTokenExpired, mappingId, mappingStatus, normaliseMapping, scopeList,
} from '../../../utils/integrations.js';


/* ═══════════════════════════════════════════════════════════════════════════
   Identity presentation
   ═══════════════════════════════════════════════════════════════════════════ */

/**
 * Avatar — initials on a neutral tile.
 *
 * A UUID is unverifiable at a glance, which is the most common cause of a
 * mis-targeted assignment. Every place a principal appears, it appears as a
 * named object, the way Entra and Okta render a linked account — never as a
 * raw identifier.
 */
export function Avatar({ name, size = 'md', className }) {
  const sizes = {
    sm: 'h-6 w-6 text-3xs',
    md: 'h-8 w-8 text-2xs',
    lg: 'h-11 w-11 text-[13px]',
  };
  return (
    <span
      aria-hidden="true"
      className={classNames(
        'inline-flex shrink-0 items-center justify-center rounded-full bg-slate-100 font-semibold uppercase text-slate-600 ring-1 ring-inset ring-slate-200',
        sizes[size] || sizes.md,
        className
      )}
    >
      {initials(name || '') || '?'}
    </span>
  );
}

/** The IAM principal a mapping is bound to. */
export function LinkedUser({ userId, directory, isSelf = false }) {
  if (!userId) return <span className="text-slate-400">—</span>;
  const name = directory?.[userId];
  return (
    <div className="flex min-w-0 items-center gap-2.5">
      <Avatar name={name || userId} size="sm" />
      <div className="min-w-0">
        <Link
          to={`/identity/users/${encodeURIComponent(userId)}`}
          onClick={(e) => e.stopPropagation()}
          className="flex items-center gap-1.5 truncate text-[13px] font-medium text-brand-700 hover:text-brand-800"
          title={name || userId}
        >
          <span className="truncate">{name || 'Directory user'}</span>
          {isSelf && <Badge tone="outline">You</Badge>}
        </Link>
      </div>
    </div>
  );
}


/* ═══════════════════════════════════════════════════════════════════════════
   Small presentational pieces
   ═══════════════════════════════════════════════════════════════════════════ */

export function DetailRow({ label, children, mono = false }) {
  return (
    <div className="grid grid-cols-[140px_1fr] items-start gap-3 py-2">
      <dt className="text-2xs font-medium uppercase tracking-[0.07em] text-slate-400">{label}</dt>
      <dd
        className={classNames(
          'min-w-0 break-words text-[13px] text-ink-800',
          mono && 'font-mono text-xs'
        )}
      >
        {children}
      </dd>
    </div>
  );
}

export function CopyableValue({ value, onCopy, title = 'Copy to clipboard' }) {
  if (!value) return <span className="text-slate-400">—</span>;
  return (
    <span className="flex items-start gap-1.5">
      <span className="min-w-0 flex-1 break-all font-mono text-xs text-ink-800">{value}</span>
      <IconButton icon={Copy} title={title} onClick={() => onCopy(value)} />
    </span>
  );
}

/** Scope chips with an overflow counter, so a wide scope set never breaks a row. */
export function ScopeChips({ scopes, max = 3 }) {
  const list = scopeList(scopes);
  if (!list.length) return <span className="text-slate-400">—</span>;
  const shown = list.slice(0, max);
  const rest = list.length - shown.length;
  return (
    <span className="flex flex-wrap items-center gap-1" title={list.join(', ')}>
      {shown.map((s) => (
        <Badge key={s} tone="outline" mono>
          {s}
        </Badge>
      ))}
      {rest > 0 && <Badge tone="slate">+{rest}</Badge>}
    </span>
  );
}

/** Status badge plus the separate credential-expiry warning. */
export function MappingStatus({ mapping }) {
  return (
    <span className="flex flex-wrap items-center gap-1.5">
      <StatusBadge status={mappingStatus(mapping)} />
      {isTokenExpired(mapping) && (
        <Badge tone="amber" dot>
          Token expired
        </Badge>
      )}
    </span>
  );
}


/* ═══════════════════════════════════════════════════════════════════════════
   ConnectionHero — the connection's identity band
   ═══════════════════════════════════════════════════════════════════════════
   An integration page opens with WHAT this connection is and whether it is
   healthy. Okta's IdP configuration page, Entra's object blades and every
   mature integration detail view lead the same way: a branded object header
   carrying the mark, the name, the live status and the primary action, with the
   endpoint and identifiers as supporting metadata rather than as a form.

   One honest health sentence replaces a wall of figures. It states the worst
   TRUE thing first — a connection whose credentials have expired is not
   "healthy" merely because its mappings are active.
   ═══════════════════════════════════════════════════════════════════════════ */
export function ConnectionHero({
  resource,
  provider,
  activeCount,
  totalCount,
  expiredCount,
  loading,
  error,
  onCopy,
  actions,
}) {
  const ProviderIcon = provider.icon;

  const health = (() => {
    if (loading) return { tone: 'slate', label: 'Checking connection…' };
    if (error) return { tone: 'amber', label: 'Identity mappings unavailable' };
    if (!resource.is_active) return { tone: 'slate', label: 'Resource disabled in the registry' };
    if (totalCount === 0) return { tone: 'sky', label: 'Awaiting first identity mapping' };
    if (expiredCount > 0) {
      return {
        tone: 'amber',
        label: `${expiredCount} credential${expiredCount === 1 ? '' : 's'} need renewing`,
      };
    }
    if (activeCount === 0) return { tone: 'slate', label: 'No mapping is currently in force' };
    return {
      tone: 'green',
      label: `${activeCount} identit${activeCount === 1 ? 'y' : 'ies'} linked and active`,
    };
  })();

  return (
    <section className="card overflow-hidden">
      <div className="flex flex-col gap-5 px-5 py-5 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex min-w-0 items-start gap-4">
          {/* The provider mark carries the brand weight — the only strongly
              inked object on the page, so the eye lands on the connection. */}
          <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl bg-ink-900 text-white shadow-card">
            <ProviderIcon className="h-6 w-6" />
          </span>
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="truncate text-[17px] font-semibold leading-tight text-ink-900">
                {resource.resource_name || provider.label}
              </h2>
              <Badge tone="slate" mono>
                {provider.id}
              </Badge>
              <StatusBadge status={resource.is_active ? 'ACTIVE' : 'DISABLED'} />
            </div>
            <p className="mt-1.5 flex items-center gap-1.5 text-[13px]">
              <span
                className={classNames(
                  'h-1.5 w-1.5 shrink-0 rounded-full',
                  health.tone === 'green' && 'bg-emerald-500',
                  health.tone === 'amber' && 'bg-amber-500',
                  health.tone === 'sky' && 'bg-sky-500',
                  health.tone === 'slate' && 'bg-slate-400'
                )}
              />
              <span
                className={classNames(
                  'truncate font-medium',
                  health.tone === 'green' && 'text-emerald-700',
                  health.tone === 'amber' && 'text-amber-700',
                  health.tone === 'sky' && 'text-sky-700',
                  health.tone === 'slate' && 'text-slate-600'
                )}
              >
                {health.label}
              </span>
            </p>
            {resource.target_url && (
              <a
                href={resource.target_url}
                target="_blank"
                rel="noreferrer noopener"
                className="mt-2 inline-flex max-w-full items-center gap-1.5 text-xs text-slate-500 hover:text-brand-700"
              >
                <Link2 className="h-3.5 w-3.5 shrink-0" />
                <span className="truncate">{resource.target_url.replace(/^https?:\/\//, '')}</span>
                <ExternalLink className="h-3 w-3 shrink-0" />
              </a>
            )}
          </div>
        </div>

        {actions && <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>}
      </div>

      {/* Identifiers live in a quiet footer rail: needed often enough to be one
          click away, not important enough to compete with the connection. */}
      {resource.resource_arn && (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-line-soft bg-slate-50/60 px-5 py-2.5">
          <span className="flex min-w-0 items-center gap-1.5">
            <span className="text-3xs font-semibold uppercase tracking-[0.09em] text-slate-400">
              ARN
            </span>
            <span className="truncate font-mono text-xs text-ink-700" title={resource.resource_arn}>
              {resource.resource_arn}
            </span>
            <IconButton
              icon={Copy}
              size="xs"
              title="Copy ARN"
              onClick={() => onCopy(resource.resource_arn)}
            />
          </span>
        </div>
      )}
    </section>
  );
}


/* ═══════════════════════════════════════════════════════════════════════════
   FirstRunPanel — the zero-data state, treated as onboarding
   ═══════════════════════════════════════════════════════════════════════════
   A brand-new connection has nothing to count. Rendering a row of zeroed KPI
   tiles at that moment is the single most common dashboard mistake: it fills
   the screen with numbers that carry no information and reads as though the
   product is broken. Mature consoles use the empty state as the onboarding
   surface instead — say WHY it is empty, say WHAT will appear here, and offer
   exactly ONE action.
   ═══════════════════════════════════════════════════════════════════════════ */
export function FirstRunPanel({ provider, onCreate }) {
  const ProviderIcon = provider.icon;
  const steps = [
    {
      title: 'Choose the IAM user',
      body: 'The principal in this tenant that the external login belongs to. Defaults to your own account.',
    },
    {
      title: `Enter the ${provider.identityLabel.toLowerCase()}`,
      body: `The login exactly as it appears on ${provider.label} — this is the value the platform matches on.`,
    },
    {
      title: 'Govern the link',
      body: 'Record the granted scopes and the credential expiry, then deactivate the link when the person leaves.',
    },
  ];

  return (
    <section className="card overflow-hidden">
      <div className="flex flex-col items-center px-6 py-12 text-center">
        <span className="flex h-14 w-14 items-center justify-center rounded-2xl bg-slate-100 text-ink-800">
          <ProviderIcon className="h-7 w-7" />
        </span>
        <h3 className="mt-5 text-[15px] font-semibold text-ink-900">
          No {provider.label} identities are mapped yet
        </h3>
        <p className="mt-2 max-w-md text-[13px] leading-relaxed text-slate-500">
          Until a login is mapped, activity on this resource resolves to an unattributed external
          account. Map one to bind it to a known principal in this tenant.
        </p>
        <div className="mt-6">
          <Button size="lg" onClick={onCreate}>
            <Plus className="h-4 w-4" /> Map {provider.label} identity
          </Button>
        </div>
      </div>

      <ol className="grid grid-cols-1 divide-y divide-line-soft border-t border-line-soft sm:grid-cols-3 sm:divide-x sm:divide-y-0">
        {steps.map((step, i) => (
          <li key={step.title} className="px-5 py-4">
            <span className="flex items-center gap-2">
              <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-slate-100 text-3xs font-semibold text-slate-600 tabular">
                {i + 1}
              </span>
              <span className="text-[13px] font-semibold text-ink-900">{step.title}</span>
            </span>
            <p className="mt-1.5 text-xs leading-relaxed text-slate-500">{step.body}</p>
          </li>
        ))}
      </ol>
    </section>
  );
}


/* ═══════════════════════════════════════════════════════════════════════════
   PrincipalPicker — choose the IAM user a mapping belongs to
   ═══════════════════════════════════════════════════════════════════════════
   TWO BUGS FIXED HERE, both visible in the same screen:

   1. THE FIELD LOOKED EMPTY WHILE HOLDING A VALUE.
      SearchableCombobox resolves its display label by finding the committed
      value inside `options` (`options.find(o => o.id === value)`). The dialog
      pre-selects the signed-in operator, but the option list was built purely
      from the directory read — so whenever that read failed OR had not landed
      yet, there was no option to match, and a REQUIRED field that already held
      a perfectly good value rendered as an empty placeholder. The operator was
      shown a red failure under a field they had not touched and could not fix.
      FIX: the signed-in operator is ALWAYS seeded into the option list from the
      auth profile, independently of the directory. The default selection is
      therefore always resolvable, and mapping your own identity keeps working
      even when directory search is unavailable.

   2. A DIRECTORY OUTAGE WAS RENDERED AS FIELD INVALIDITY.
      The failure was passed to the combobox as `error`, which paints the
      control red and marks it aria-invalid. The field is not invalid — a valid
      principal is selected. FIX: the outage is a quiet, non-blocking note that
      states the reduced capability and leaves the control in its normal state.
      `error` is now reserved for genuine validation failures.

   ALSO REMOVED: the raw `user_id <uuid>` line beneath the control. Enterprise
   consoles resolve a principal to a NAME and keep the identifier in the record
   view; echoing a UUID back in a create form is noise an operator cannot act
   on. The selection is confirmed as a person instead.
   ═══════════════════════════════════════════════════════════════════════════ */
export function PrincipalPicker({
  value,
  onChange,
  currentUser,
  currentUserId,
  userOptions = [],
  loading = false,
  directoryUnavailable = false,
  error,
}) {
  /* The signed-in operator is seeded first and de-duplicated against the
     directory, so the pre-selected default always has a label to render. */
  const options = useMemo(() => {
    const list = [];
    if (currentUserId) {
      const fromDirectory = userOptions.find((o) => o.id === currentUserId);
      list.push({
        id: currentUserId,
        label:
          fromDirectory?.label || currentUser?.username || currentUser?.email || 'Your account',
        description: fromDirectory?.description || currentUser?.email || undefined,
        badge: 'You',
      });
    }
    userOptions.forEach((o) => {
      if (o.id !== currentUserId) list.push(o);
    });
    return list;
  }, [userOptions, currentUserId, currentUser]);

  const selected = options.find((o) => o.id === value) || null;
  const isSelf = !!currentUserId && value === currentUserId;

  return (
    <div>
      <SearchableCombobox
        label="IAM user"
        placeholder="Search users by name or email…"
        options={options}
        value={value}
        onChange={(id) => onChange(id || '')}
        loading={loading}
        required
        error={error}
        emptyMessage={
          directoryUnavailable
            ? 'Directory search is unavailable right now.'
            : 'No users match that name or email.'
        }
        hint={
          directoryUnavailable
            ? undefined
            : 'Defaults to your own account. Search the directory to map someone else.'
        }
      />

      {/* A reduced capability, stated plainly — not a validation failure. */}
      {directoryUnavailable && !error && (
        <p className="mt-1.5 flex items-start gap-1.5 text-xs leading-snug text-slate-500">
          <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0 text-amber-500" />
          <span>
            Directory search is unavailable, so other users cannot be looked up right now. Your own
            account is still selectable.
          </span>
        </p>
      )}

      {/* The resolved principal, confirmed as a person rather than an id. */}
      {value && (
        <div className="mt-2 flex items-center gap-2.5 rounded-lg border border-line-soft bg-slate-50/70 px-3 py-2">
          <Avatar name={selected?.label || 'User'} size="sm" />
          <div className="min-w-0 flex-1">
            <p className="truncate text-[13px] font-medium text-ink-900">
              {selected?.label || 'Selected user'}
            </p>
            {selected?.description && (
              <p className="truncate text-xs text-slate-500">{selected.description}</p>
            )}
          </div>
          {isSelf ? (
            <Badge tone="brand">Signed in as you</Badge>
          ) : (
            currentUserId && (
              <Button variant="link" size="xs" onClick={() => onChange(currentUserId)}>
                <UserRoundCheck className="h-3.5 w-3.5" /> Use my account
              </Button>
            )
          )}
        </div>
      )}
    </div>
  );
}


/* ═══════════════════════════════════════════════════════════════════════════
   MappingFormModal — create and edit
   ═══════════════════════════════════════════════════════════════════════════
     CREATE  POST /api/v1/integrations  { user_id, provider, external_id }
             Exactly those three fields — nothing else is in the create
             contract, so nothing else is sent.
     EDIT    PUT  /api/v1/integrations/<id>
             { status, scopes, metadata, token_expires_at }
             The principal, the provider and the external identity are the
             record's IDENTITY, so they are shown read-only here: the update
             contract does not accept them, and silently discarding typed input
             would be worse than not offering the field.

   The user directory is passed IN from the page rather than fetched here. The
   page already loads it to resolve names in the table, and a picker that
   fetched its own copy meant the same request went out twice every time this
   dialog opened.
   ═══════════════════════════════════════════════════════════════════════════ */
export function MappingFormModal({
  open,
  mode = 'create',
  provider,
  mapping,
  currentUser,
  currentUserId,
  userOptions = [],
  usersLoading = false,
  directoryUnavailable = false,
  existingMappings = [],
  directory,
  onClose,
  onSaved,
}) {
  const toast = useToast();
  const isEdit = mode === 'edit';
  const [saving, setSaving] = useState(false);
  const [errors, setErrors] = useState({});
  const [form, setForm] = useState({
    user_id: '',
    external_id: '',
    status: 'ACTIVE',
    scopes: '',
    token_expires_at: '',
    metadata: '',
  });

  useEffect(() => {
    if (!open) return;
    setErrors({});
    if (isEdit && mapping) {
      setForm({
        user_id: mapping.user_id || '',
        external_id: mapping.external_id || '',
        status: mappingStatus(mapping) === 'DISABLED' ? 'DISABLED' : 'ACTIVE',
        scopes: scopeList(mapping.scopes).join(', '),
        token_expires_at: fromIsoExpiry(mapping.token_expires_at),
        metadata:
          mapping.metadata && typeof mapping.metadata === 'object'
            ? JSON.stringify(mapping.metadata, null, 2)
            : '',
      });
    } else {
      setForm({
        user_id: currentUserId || '',
        external_id: '',
        status: 'ACTIVE',
        scopes: '',
        token_expires_at: '',
        metadata: '',
      });
    }
  }, [open, isEdit, mapping, currentUserId]);

  const set = (key) => (e) => {
    const value = e?.target ? e.target.value : e;
    setForm((f) => ({ ...f, [key]: value }));
    setErrors((x) => ({ ...x, [key]: undefined }));
  };

  /* A duplicate is caught before the request so the operator reads a sentence
     about their tenant rather than a 409 translated into generic copy. */
  const duplicateOf = useMemo(() => {
    if (isEdit) return null;
    const candidate = form.external_id.trim().toLowerCase();
    if (!candidate) return null;
    return (
      existingMappings.find(
        (m) => String(m.external_id ?? '').trim().toLowerCase() === candidate
      ) || null
    );
  }, [isEdit, form.external_id, existingMappings]);

  const validate = () => {
    const next = {};
    if (!isEdit) {
      if (!form.user_id) next.user_id = 'Select the IAM user this identity belongs to.';
      const identityError = provider.validateExternalId(form.external_id);
      if (identityError) next.external_id = identityError;
      else if (duplicateOf) {
        next.external_id =
          mappingStatus(duplicateOf) === 'DISABLED'
            ? `“${form.external_id.trim()}” is already mapped on a deactivated record. Reactivate that mapping instead of creating a second one.`
            : `“${form.external_id.trim()}” is already mapped to a user in this tenant.`;
      }
    } else {
      if (form.metadata.trim()) {
        try {
          const parsed = JSON.parse(form.metadata);
          if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
            next.metadata = 'Metadata must be a JSON object, for example { "team": "platform" }.';
          }
        } catch {
          next.metadata = 'Metadata is not valid JSON. Check for a missing quote, comma or brace.';
        }
      }
      if (form.token_expires_at && isPastExpiry(form.token_expires_at)) {
        next.token_expires_at = 'Choose a future date — an expiry in the past grants no access.';
      }
    }
    setErrors(next);
    return Object.keys(next).length === 0;
  };

  const submit = async (e) => {
    e?.preventDefault?.();
    if (saving) return;
    if (!validate()) return;

    setSaving(true);
    try {
      if (isEdit) {
        const id = mappingId(mapping);
        if (!id) {
          toast.error('This mapping has no identifier and cannot be updated.');
          return;
        }
        /* Echo `scopes` back in the shape it arrived in. A deployment that
           stores a delimited string must not be handed an array, and vice
           versa. */
        const parsedScopes = scopeList(form.scopes);
        const scopes =
          typeof mapping?.scopes === 'string' ? parsedScopes.join(',') : parsedScopes;

        await integrationApi.mappings.update(id, {
          status: form.status,
          scopes,
          metadata: form.metadata.trim() ? JSON.parse(form.metadata) : {},
          token_expires_at: toIsoExpiry(form.token_expires_at),
        });
        toast.success(`Mapping for “${mapping.external_id}” updated.`);
      } else {
        await integrationApi.mappings.create({
          user_id: form.user_id,
          provider: provider.id,
          external_id: form.external_id.trim(),
        });
        toast.success(
          `${provider.label} identity “${form.external_id.trim()}” mapped successfully.`
        );
      }
      onSaved?.();
      onClose?.();
    } catch (err) {
      toast.error(
        err.userMessage ||
          (isEdit ? 'Could not update this mapping.' : 'Could not create this mapping.')
      );
    } finally {
      setSaving(false);
    }
  };

  const ProviderIcon = provider.icon;

  return (
    <Modal
      open={open}
      onClose={onClose}
      size="form"
      icon={ProviderIcon}
      title={isEdit ? `Edit ${provider.label} mapping` : `Map a ${provider.label} identity`}
      description={
        isEdit
          ? 'Lifecycle, scopes and credential expiry for this external identity.'
          : `Bind a ${provider.label} login to an IAM user so activity on this resource resolves to a known principal.`
      }
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={submit} loading={saving}>
            {isEdit ? 'Save changes' : 'Create mapping'}
          </Button>
        </>
      }
    >
      <form onSubmit={submit} className="space-y-4" noValidate>
        <FormErrorSummary errors={errors} />

        {/* Provider is FIXED by the resource that was opened. It reads as a
            resolved fact, not a disabled input — there is nothing to fill in,
            so it should not look like a field awaiting typing. */}
        <div>
          <p className="label-base">Provider</p>
          <div className="flex items-center gap-2.5 rounded-lg border border-line-soft bg-slate-50/70 px-3 py-2">
            <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-ink-900 text-white">
              <ProviderIcon className="h-3.5 w-3.5" />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[13px] font-medium text-ink-900">
                {provider.label}
              </span>
              <span className="block truncate font-mono text-2xs text-slate-500">
                {provider.id}
              </span>
            </span>
            <Check className="h-4 w-4 shrink-0 text-emerald-600" />
          </div>
          <p className="mt-1.5 text-xs leading-snug text-slate-500">
            Set from the resource you opened — every mapping created here is a {provider.label}{' '}
            mapping.
          </p>
        </div>

        {isEdit ? (
          <>
            <div>
              <p className="label-base">IAM user</p>
              <div className="rounded-lg border border-line-soft bg-slate-50/70 px-3 py-2">
                <LinkedUser
                  userId={mapping?.user_id}
                  directory={directory}
                  isSelf={mapping?.user_id === currentUserId}
                />
              </div>
              <p className="mt-1.5 text-xs leading-snug text-slate-500">
                The principal and the external identity define this record. To bind this identity
                to a different user, deactivate this mapping and create a new one.
              </p>
            </div>

            <div>
              <p className="label-base">{provider.identityLabel}</p>
              <div className="flex items-center justify-between gap-2 rounded-lg border border-line-soft bg-slate-50/70 px-3 py-2">
                <span className="min-w-0 truncate font-mono text-[13px] text-ink-900">
                  {form.external_id}
                </span>
                <a
                  href={provider.profileUrl(form.external_id)}
                  target="_blank"
                  rel="noreferrer noopener"
                  className="inline-flex shrink-0 items-center gap-1 text-xs text-brand-700 hover:text-brand-800"
                >
                  <ExternalLink className="h-3 w-3" /> Open
                </a>
              </div>
            </div>

            <Select label="Status" value={form.status} onChange={set('status')} required>
              <option value="ACTIVE">Active — the mapping is in force</option>
              <option value="DISABLED">Disabled — retained but not applied</option>
            </Select>

            <Input
              label="Scopes"
              value={form.scopes}
              onChange={set('scopes')}
              error={errors.scopes}
              placeholder="read:user, read:org"
              className="font-mono"
              hint="Comma separated. Records the access this identity was granted at the provider."
            />
            {provider.commonScopes?.length > 0 && (
              <div className="-mt-2 flex flex-wrap items-center gap-1.5">
                <span className="text-2xs text-slate-500">Common:</span>
                {provider.commonScopes.map((scope) => {
                  const active = scopeList(form.scopes).includes(scope);
                  return (
                    <button
                      key={scope}
                      type="button"
                      onClick={() => {
                        const current = scopeList(form.scopes);
                        const nextScopes = active
                          ? current.filter((s) => s !== scope)
                          : [...current, scope];
                        setForm((f) => ({ ...f, scopes: nextScopes.join(', ') }));
                      }}
                      className={classNames(
                        'rounded-md px-1.5 py-0.5 font-mono text-2xs ring-1 ring-inset transition-colors',
                        active
                          ? 'bg-brand-50 text-brand-700 ring-brand-200'
                          : 'bg-white text-slate-600 ring-slate-300 hover:bg-slate-50'
                      )}
                    >
                      {scope}
                    </button>
                  );
                })}
              </div>
            )}

            <ExpiryInput
              label="Token expires at"
              value={form.token_expires_at}
              onChange={set('token_expires_at')}
              error={errors.token_expires_at}
              hint="Leave empty when the provider credential does not expire."
            />

            <Textarea
              label="Metadata"
              rows={4}
              value={form.metadata}
              onChange={set('metadata')}
              error={errors.metadata}
              className="font-mono text-xs"
              placeholder={'{\n  "team": "platform"\n}'}
              hint="Optional JSON object stored alongside the mapping."
            />
          </>
        ) : (
          <>
            <PrincipalPicker
              value={form.user_id}
              onChange={(id) => {
                setForm((f) => ({ ...f, user_id: id }));
                setErrors((x) => ({ ...x, user_id: undefined }));
              }}
              currentUser={currentUser}
              currentUserId={currentUserId}
              userOptions={userOptions}
              loading={usersLoading}
              directoryUnavailable={directoryUnavailable}
              error={errors.user_id}
            />

            <Input
              label={provider.identityLabel}
              value={form.external_id}
              onChange={set('external_id')}
              error={errors.external_id}
              placeholder={provider.identityPlaceholder}
              className="font-mono"
              required
              hint={provider.identityHint}
            />
          </>
        )}
      </form>
    </Modal>
  );
}


/* ═══════════════════════════════════════════════════════════════════════════
   MappingRecordModal — the authoritative single record
   ═══════════════════════════════════════════════════════════════════════════
   Reads GET /api/v1/integrations/<id> rather than reusing the row from the
   list: the list is a snapshot, and this dialog is where an operator goes to
   check what the platform actually holds before acting on it.
   ═══════════════════════════════════════════════════════════════════════════ */
export function MappingRecordModal({
  mapping,
  provider,
  directory,
  currentUserId,
  onClose,
  onEdit,
  onDeactivate,
  onReactivate,
  onCopy,
}) {
  const id = mappingId(mapping);
  const record = useResource(
    () => (id ? integrationApi.mappings.get(id) : Promise.resolve(null)),
    [id]
  );

  // Fall back to the row we already have if the single-record read fails, so
  // the dialog is never blank.
  const data = normaliseMapping(record.data) || mapping || {};
  const status = mappingStatus(data);
  const expired = isTokenExpired(data);
  const meta = data.metadata && typeof data.metadata === 'object' ? data.metadata : {};
  const metaEntries = Object.entries(meta);
  const ProviderIcon = provider.icon;

  return (
    <Modal
      open={!!mapping}
      onClose={onClose}
      size="lg"
      icon={ProviderIcon}
      title={data.external_id || `${provider.label} mapping`}
      description={`Full integration record held by the platform for this ${provider.label} identity.`}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Close
          </Button>
          <Button variant="secondary" onClick={() => onEdit?.(data)}>
            Edit mapping
          </Button>
          {status === 'DISABLED' ? (
            <Button onClick={() => onReactivate?.(data)}>Reactivate</Button>
          ) : (
            <Button variant="danger" onClick={() => onDeactivate?.(data)}>
              Deactivate
            </Button>
          )}
        </>
      }
    >
      {record.loading && !mapping ? (
        <div className="flex justify-center py-10">
          <Spinner />
        </div>
      ) : (
        <div className="space-y-4">
          <div className="flex flex-wrap items-center gap-2">
            <MappingStatus mapping={data} />
            <Badge tone="slate" mono>
              {data.provider || provider.id}
            </Badge>
            {record.error && (
              <Badge tone="amber">Showing the last loaded copy of this record</Badge>
            )}
          </div>

          {expired && status === 'ACTIVE' && (
            <div
              role="status"
              className="flex items-start gap-2 rounded-xl border border-amber-200 bg-amber-50/70 px-4 py-3"
            >
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />
              <p className="text-xs leading-relaxed text-ink-700/80">
                The credential recorded against this mapping expired{' '}
                {formatRelative(data.token_expires_at)} ({formatDateTime(data.token_expires_at)}).
                The mapping is still active — update the expiry once the credential has been
                renewed at the provider.
              </p>
            </div>
          )}

          <section>
            <h4 className="flex items-center gap-1.5 text-2xs font-semibold uppercase tracking-[0.1em] text-slate-400">
              <ProviderIcon className="h-3.5 w-3.5" /> External identity
            </h4>
            <dl className="mt-1 divide-y divide-line-soft">
              <DetailRow label={provider.identityLabel}>
                {data.external_id ? (
                  <span className="flex flex-wrap items-center gap-2">
                    <span className="break-all font-mono text-xs text-ink-800">
                      {data.external_id}
                    </span>
                    <a
                      href={provider.profileUrl(data.external_id)}
                      target="_blank"
                      rel="noreferrer noopener"
                      className="inline-flex items-center gap-1 text-xs text-brand-700 hover:text-brand-800"
                    >
                      <ExternalLink className="h-3 w-3" /> Open on {provider.label}
                    </a>
                  </span>
                ) : (
                  <span className="text-slate-400">—</span>
                )}
              </DetailRow>
              <DetailRow label="Provider" mono>
                {data.provider || provider.id}
              </DetailRow>
              <DetailRow label="Integration ID">
                <CopyableValue value={id} onCopy={onCopy} title="Copy integration id" />
              </DetailRow>
            </dl>
          </section>

          <section>
            <h4 className="flex items-center gap-1.5 text-2xs font-semibold uppercase tracking-[0.1em] text-slate-400">
              <ShieldCheck className="h-3.5 w-3.5" /> Linked principal
            </h4>
            <dl className="mt-1 divide-y divide-line-soft">
              <DetailRow label="IAM user">
                <LinkedUser
                  userId={data.user_id}
                  directory={directory}
                  isSelf={data.user_id === currentUserId}
                />
              </DetailRow>
              <DetailRow label="User ID">
                <CopyableValue value={data.user_id} onCopy={onCopy} title="Copy user id" />
              </DetailRow>
            </dl>
          </section>

          <section>
            <h4 className="flex items-center gap-1.5 text-2xs font-semibold uppercase tracking-[0.1em] text-slate-400">
              <KeyRound className="h-3.5 w-3.5" /> Access
            </h4>
            <dl className="mt-1 divide-y divide-line-soft">
              <DetailRow label="Scopes">
                <ScopeChips scopes={data.scopes} max={12} />
              </DetailRow>
              <DetailRow label="Token expires">
                {data.token_expires_at ? (
                  <span className={expired ? 'text-amber-700' : undefined}>
                    {formatDateTime(data.token_expires_at)}
                    {expired && ' — expired'}
                  </span>
                ) : (
                  <span className="text-slate-400">No expiry recorded</span>
                )}
              </DetailRow>
            </dl>
          </section>

          <section>
            <h4 className="flex items-center gap-1.5 text-2xs font-semibold uppercase tracking-[0.1em] text-slate-400">
              <Clock className="h-3.5 w-3.5" /> Provenance
            </h4>
            <dl className="mt-1 divide-y divide-line-soft">
              <DetailRow label="Created">{formatDateTime(data.created_at)}</DetailRow>
              <DetailRow label="Updated">{formatDateTime(data.updated_at)}</DetailRow>
              {metaEntries.length > 0 &&
                metaEntries.map(([key, value]) => (
                  <DetailRow key={key} label={key.replace(/_/g, ' ')}>
                    {typeof value === 'object' ? JSON.stringify(value) : String(value)}
                  </DetailRow>
                ))}
            </dl>
          </section>
        </div>
      )}
    </Modal>
  );
}
