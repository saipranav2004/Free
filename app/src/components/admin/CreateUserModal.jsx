import { useEffect, useMemo, useState } from 'react'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { UserPlus, Eye, EyeOff, Wand2, Check, AlertCircle, Info, Download } from 'lucide-react'
import clsx from 'clsx'
import { createUser, assignRole } from '../../api/identity'
import { listRoles } from '../../api/rbac'
import {
  SYSTEM_ROLES,
  isSystemRole,
  isPrivilegedRoleName,
  roleBlurb,
  normalizeRoleList,
  canCreateWithRoleName,
} from '../../config/constants'
import { Modal } from '../common/Modal'
import { Field, inputClass, selectClass, FieldSet } from '../common/FormFields'
import { Button } from '../common/Button'
import { apiErrorMessage } from '../../lib/apiError'
import { downloadUserCredentialsXlsx } from '../../lib/exportUserCredentials'
import {
  fullNameRules,
  usernameRules,
  passwordStrength,
  suggestPassword,
  PASSWORD_MIN,
} from '../../lib/validators'

// ---------------------------------------------------------------------------
// Create user
// ---------------------------------------------------------------------------
// The rules the user asked for, enforced two ways so they can't be bypassed
// and can't surprise anyone:
//
//   Full name, letters and single spaces only. Digits and symbols are
// dropped AS YOU TYPE (typing "3" does nothing) rather than accepted and
// scolded on submit. Unicode-aware, so "Zoë Ferreira" is a valid name and
//   "user123" is not.
//
//   Username, Instagram-style: lowercase letters, digits, underscore and
// period; no spaces; can't start or end with a period; no double periods;
//   3–30 characters. Uppercase is folded to lowercase live (typing "Alice"
// yields "alice"), which is what every platform with this rule does ,
// rejecting the keystroke instead would just look broken.
//
// Both live in lib/validators.js and are used by BOTH the sanitizer and the
// zod schema, so the field and the submit check can never disagree.

const schema = z.object({
  username: z
    .string()
    .trim()
    .min(1, 'A username is required')
    .refine(usernameRules.test, usernameRules.message),
  email: z.string().trim().min(1, 'An email address is required').email('That is not a valid email address'),
  full_name: z
    .string()
    .trim()
    .optional()
    .refine((v) => fullNameRules.test(v), fullNameRules.message),
  password: z.string().min(PASSWORD_MIN, `At least ${PASSWORD_MIN} characters`),
  role: z.string().optional(),
})

const DEFAULT_ROLE = 'user'

// Live rule checklist. Three things people get wrong on a username field,
// shown as they type instead of as a paragraph of red text after submit.
function UsernameRules({ value }) {
  const v = String(value || '')
  const checks = [
    { ok: v.length >= 3 && v.length <= 30, label: '3–30 characters' },
    { ok: /^[a-z0-9._]*$/.test(v) && v.length > 0, label: 'Lowercase, numbers, _ and .' },
    {
      ok: v.length > 0 && !/^[._]/.test(v) && !/\.$/.test(v) && !/\.{2,}/.test(v) && !/^\d+$/.test(v),
      label: 'No leading/trailing dot, not all digits',
    },
  ]
  return (
    <ul className="mt-2 flex flex-wrap gap-x-4 gap-y-1">
      {checks.map((c) => (
        <li key={c.label} className="flex items-center gap-1.5 text-2xs">
          <span
            className={clsx(
              'flex h-3.5 w-3.5 flex-none items-center justify-center rounded-full ring-1 ring-inset',
              c.ok
                ? 'bg-emerald-50 text-emerald-600 ring-emerald-600/25 dark:bg-emerald-500/15 dark:text-emerald-300 dark:ring-emerald-500/30'
                : 'bg-surface-800 text-ink-600 ring-surface-700'
            )}
          >
            {c.ok ? <Check className="h-2 w-2" strokeWidth={4} /> : null}
          </span>
          <span className={c.ok ? 'text-ink-400' : 'text-ink-500'}>{c.label}</span>
        </li>
      ))}
    </ul>
  )
}

export function CreateUserModal({ open, onClose }) {
  const queryClient = useQueryClient()
  const [showPassword, setShowPassword] = useState(false)

  const {
    register,
    handleSubmit,
    reset,
    watch,
    setValue,
    formState: { errors },
  } = useForm({
    resolver: zodResolver(schema),
    mode: 'onBlur',
    defaultValues: { username: '', email: '', full_name: '', password: '', role: DEFAULT_ROLE },
  })

  useEffect(() => {
    if (open) {
      reset({ username: '', email: '', full_name: '', password: '', role: DEFAULT_ROLE })
      setShowPassword(false)
    }
  }, [open, reset])

  const username = watch('username') || ''
  const fullName = watch('full_name') || ''
  const password = watch('password') || ''
  const role = watch('role') || DEFAULT_ROLE
  const strength = passwordStrength(password)

  // Every role the install has, not just the three built-ins, an account
  // could otherwise only ever be created with a system role, and its custom
  // one had to be added afterwards from the account's own page. Shares the
  // Roles screen's cache entry, so a role created there is offered here
  // straight away. Only fetched while the modal is open.
  const rolesQuery = useQuery({
    queryKey: ['admin', 'roles'],
    queryFn: ({ signal }) => listRoles(signal),
    enabled: open,
  })

  // WHAT AN ACCOUNT CAN BE CREATED AS. `user`, the baseline every account
  // gets, plus any custom role. Never `admin` and never `root`: there is one
  // root per company, and administrative access is granted afterwards by root
  // through admin delegation, which records a reason and can be revoked. A
  // create form that could mint an admin would be a second, unaudited door
  // into the same privilege.
  //
  // If the catalogue hasn't loaded (or the call failed) the built-ins still
  // have to be offered: this form must never lose the ability to pick a role.
  const roleOptions = useMemo(() => {
    const catalogue = normalizeRoleList(rolesQuery.data)
    const source = catalogue.length > 0 ? catalogue : SYSTEM_ROLES.map((name) => ({ name }))
    return source.filter((r) => canCreateWithRoleName(r.name))
  }, [rolesQuery.data])

  const systemRoleOptions = roleOptions.filter((r) => isSystemRole(r))
  const customRoleOptions = roleOptions.filter((r) => !isSystemRole(r))
  const selectedRole = roleOptions.find((r) => String(r.name).toLowerCase() === String(role).toLowerCase())

  const mutation = useMutation({
    mutationFn: async ({ role: chosenRole, ...payload }) => {
      // Checked BEFORE the account exists, not between the two calls: failing
      // afterwards would leave a created account with the wrong role and no
      // obvious way to tell that is what happened.
      if (chosenRole && !canCreateWithRoleName(chosenRole)) {
        const err = new Error(
          'Administrative access is granted from the account’s own page by a root user, not at creation.'
        )
        err.clientBlocked = true
        throw err
      }
      const user = await createUser({
        ...payload,
        full_name: payload.full_name?.trim() || undefined,
      })
      // Role assignment is a second call by design, POST /identity/users
      // creates the account, RBAC assignment is its own endpoint. Only the
      // non-default role needs it.
      if (chosenRole && chosenRole !== DEFAULT_ROLE) {
        await assignRole(user.user_id, chosenRole)
      }
      return user
    },
    onSuccess: (_user, variables) => {
      queryClient.invalidateQueries({ queryKey: ['admin', 'users'] })
      toast.success(`Account “${variables.username}” created`)
      // The password is never retrievable again after this response, so the
      // handover file has to be built from what was just submitted, not from
      // the created-user payload.
      downloadUserCredentialsXlsx({
        username: variables.username,
        email: variables.email,
        password: variables.password,
        role: variables.role || DEFAULT_ROLE,
      }).catch(() => toast.error('Account created, but the credentials file failed to download.'))
      onClose()
    },
    onError: (err) => toast.error(err?.clientBlocked ? err.message : apiErrorMessage(err)),
  })

  // Suggest a username from the name they typed, the one keystroke-saver
  // that matters on this form, and it always produces a value that passes.
  const suggestFromName = () => {
    const suggestion = usernameRules.sanitize(fullName.trim().replace(/\s+/g, '.'))
    if (suggestion.length >= 3) setValue('username', suggestion, { shouldValidate: true })
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      icon={UserPlus}
      title="Create a user account"
      description="The account is created immediately and can sign in as soon as it exists. Its first password is shown only once, a handover file downloads automatically."
      size="xl"
      busy={mutation.isPending}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={mutation.isPending}>
            Cancel
          </Button>
          <Button
            form="create-user-form"
            type="submit"
            variant="primary"
            icon={UserPlus}
            loading={mutation.isPending}
          >
            Create account
          </Button>
        </>
      }
    >
      <form
        id="create-user-form"
        onSubmit={handleSubmit((v) => mutation.mutate(v))}
        noValidate
        className="space-y-6"
      >
        <FieldSet title="Identity">
          <Field
            label="Full name"
            hint={fullNameRules.hint}
            error={errors.full_name?.message}
            htmlFor="cu-fullname"
          >
            <div className="flex items-center gap-2">
              <input
                id="cu-fullname"
                autoComplete="off"
                placeholder="Aditi Sharma"
                className={inputClass(!!errors.full_name)}
                {...register('full_name', {
                  onChange: (e) => {
                    // Sanitize in place: digits and symbols never land in the
                    // field at all, so there is nothing to explain afterwards.
                    e.target.value = fullNameRules.sanitize(e.target.value)
                  },
                })}
              />
              <Button
                type="button"
                size="md"
                variant="secondary"
                onClick={suggestFromName}
                disabled={fullName.trim().length < 2}
                title="Suggest a username from this name"
              >
                Use for username
              </Button>
            </div>
          </Field>

          <Field label="Username" error={errors.username?.message} required htmlFor="cu-username">
            <input
              id="cu-username"
              autoComplete="off"
              spellCheck={false}
              placeholder="aditi.sharma"
              className={clsx(inputClass(!!errors.username), 'font-mono')}
              {...register('username', {
                onChange: (e) => {
                  e.target.value = usernameRules.sanitize(e.target.value)
                },
              })}
            />
            <UsernameRules value={username} />
          </Field>

          <Field label="Email" error={errors.email?.message} required htmlFor="cu-email">
            <input
              id="cu-email"
              type="email"
              autoComplete="off"
              placeholder="aditi.sharma@example.com"
              className={inputClass(!!errors.email)}
              {...register('email')}
            />
          </Field>
        </FieldSet>

        <FieldSet
          title="First password"
          description="Set the password this account signs in with the first time. There is no email-invite flow on this backend, you hand it over yourself."
        >
          <Field label="Password" error={errors.password?.message} required htmlFor="cu-password">
            <div className="relative">
              <input
                id="cu-password"
                type={showPassword ? 'text' : 'password'}
                autoComplete="new-password"
                spellCheck={false}
                className={clsx(inputClass(!!errors.password), 'pr-20 font-mono')}
                {...register('password')}
              />
              <div className="absolute right-1.5 top-1/2 flex -translate-y-1/2 items-center gap-0.5">
                <button
                  type="button"
                  onClick={() => setShowPassword((v) => !v)}
                  aria-label={showPassword ? 'Hide password' : 'Show password'}
                  className="flex h-7 w-7 items-center justify-center rounded-md text-ink-500 transition-colors hover:bg-surface-700 hover:text-ink-100"
                >
                  {showPassword ? (
                    <EyeOff className="h-3.5 w-3.5" strokeWidth={1.75} />
                  ) : (
                    <Eye className="h-3.5 w-3.5" strokeWidth={1.75} />
                  )}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setValue('password', suggestPassword(20), { shouldValidate: true })
                    setShowPassword(true)
                  }}
                  aria-label="Generate a strong password"
                  title="Generate a strong password"
                  className="flex h-7 w-7 items-center justify-center rounded-md text-ink-500 transition-colors hover:bg-surface-700 hover:text-ink-100"
                >
                  <Wand2 className="h-3.5 w-3.5" strokeWidth={1.75} />
                </button>
              </div>
            </div>
          </Field>

          {/* Advisory only, it never blocks a submit the server would accept. */}
          {password && (
            <div className="flex items-center gap-3">
              <div className="flex h-1.5 flex-1 gap-1">
                {[1, 2, 3, 4, 5].map((i) => (
                  <span
                    key={i}
                    className={clsx(
                      'h-full flex-1 rounded-full transition-colors duration-200',
                      i <= strength.score
                        ? strength.tone === 'red'
                          ? 'bg-red-500'
                          : strength.tone === 'amber'
                            ? 'bg-amber-500'
                            : 'bg-emerald-500'
                        : 'bg-surface-750'
                    )}
                  />
                ))}
              </div>
              <span
                className={clsx(
                  'flex-none text-2xs font-medium',
                  strength.tone === 'red'
                    ? 'text-red-600 dark:text-red-400'
                    : strength.tone === 'amber'
                      ? 'text-amber-600 dark:text-amber-400'
                      : 'text-emerald-600 dark:text-emerald-400'
                )}
              >
                {strength.label}
              </span>
            </div>
          )}

          <div className="flex items-start gap-2.5 rounded-xl border border-dashed border-surface-600 bg-surface-850/70 px-3.5 py-3">
            <Download className="mt-px h-3.5 w-3.5 flex-none text-ink-500" strokeWidth={1.75} />
            <p className="text-xs leading-relaxed text-ink-400">
              A credentials handover file downloads the moment the account is created. The password cannot be
              retrieved afterwards, only reset.
            </p>
          </div>
        </FieldSet>

        <FieldSet title="Initial role">
          <Field label="Role" htmlFor="cu-role" hint={roleBlurb(selectedRole, role)}>
            <select id="cu-role" className={selectClass(false)} {...register('role')}>
              {systemRoleOptions.length > 0 && (
                <optgroup label="Base role">
                  {systemRoleOptions.map((r) => (
                    <option key={r.name} value={r.name}>
                      {r.name}
                    </option>
                  ))}
                </optgroup>
              )}
              {customRoleOptions.length > 0 && (
                <optgroup label="Custom roles">
                  {customRoleOptions.map((r) => (
                    <option key={r.name} value={r.name}>
                      {r.name}
                    </option>
                  ))}
                </optgroup>
              )}
            </select>
          </Field>

          {isPrivilegedRoleName(role) && (
            <div className="flex items-start gap-2.5 rounded-xl border border-amber-300/70 bg-amber-50 px-3.5 py-3 dark:border-amber-900/40 dark:bg-amber-950/25">
              <AlertCircle
                className="mt-px h-3.5 w-3.5 flex-none text-amber-600 dark:text-amber-400"
                strokeWidth={1.75}
              />
              <p className="text-xs leading-relaxed text-amber-800 dark:text-amber-200">
                <span className="font-semibold">Privileged role.</span> This is granted by a root user from
                the account&apos;s own page, not at creation, and every grant is recorded in the audit log.
              </p>
            </div>
          )}

          <div className="flex items-start gap-2.5 text-xs leading-relaxed text-ink-500">
            <Info className="mt-0.5 h-3.5 w-3.5 flex-none" strokeWidth={1.75} />
            <p>
              Every account starts as a normal user. Administrative access is not offered here, a root user
              grants it afterwards from the account&apos;s own page, where it carries a reason, an optional
              expiry and an optional resource scope.
            </p>
          </div>

          <div className="flex items-start gap-2.5 text-xs leading-relaxed text-ink-500">
            <Info className="mt-0.5 h-3.5 w-3.5 flex-none" strokeWidth={1.75} />
            <p>
              Policies are attached afterwards from the account&apos;s own page, roles carry their own policy
              sets, so most accounts need nothing further.
            </p>
          </div>
        </FieldSet>
      </form>
    </Modal>
  )
}
