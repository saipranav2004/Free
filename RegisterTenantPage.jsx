/**
 * RegisterTenantPage — public company (tenant) registration.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHY THIS PAGE LOOKS LIKE THIS
 * ═══════════════════════════════════════════════════════════════════════════
 * It is the only screen a prospect sees before they have an account, so it
 * reuses the LoginPage's two-panel language exactly — navy #0f172a marketing
 * panel with the grid overlay on the left, white form panel with the #0ea5e9
 * accent on the right — rather than inventing a third visual dialect. No new
 * colours, no new type scale: the palette and the design-system tokens are
 * untouched.
 *
 * CONTRACT
 *   POST /api/v1/identity/register   (identityApi.registerTenant)
 *   body: { company_name, domain, email, first_name, last_name }
 *
 *   → data: {
 *       admin:  { account_id, email, password, username, user_id, role, … },
 *       tenant: { account_id, company_name, domain, tenant_id, status },
 *       message: "…the password will NOT be shown again."
 *     }
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * ERROR HANDLING (bug fix)
 * ═══════════════════════════════════════════════════════════════════════════
 * The backend answers a schema failure with the generic top-level message
 * "One or more fields failed validation." and puts the real reasons in the
 * envelope's `errors` object (marshmallow style: `{ email: ["Not a valid
 * email."] }`, sometimes nested under `json` / `body`). This page previously
 * rendered only `err.userMessage`, so a rejected submission looked like an
 * unexplained failure. `flattenApiErrors` now unpacks that payload, pins each
 * message to its own field, and lists anything unmapped in the summary alert.
 *
 * Values are also normalised before submit — the two fields the backend is
 * strict about are `domain` (bare host, lowercase: no scheme, no path, no
 * `www.`) and `email` (lowercase) — which removes the most common cause of a
 * server-side rejection.
 *
 * ONE-TIME CREDENTIALS
 * The root admin password is returned exactly once. On success the six
 * required columns are written to a spreadsheet and downloaded automatically,
 * using the same XLSX pattern as UsersPage's credential export. A manual
 * re-download stays available while the result is on screen.
 */
import { useState, useCallback } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import {
  Building2, Globe, Mail, User, ShieldCheck, Lock, ArrowLeft, Download,
  CheckCircle2, AlertTriangle, KeyRound,
} from 'lucide-react';
import * as XLSX from 'xlsx';
import { Logo } from '../../components/common/Logo.jsx';
import { useToast } from '../../context/ToastContext.jsx';
import { identityApi } from '../../lib/api/identity.js';
import { classNames } from '../../utils/format.js';

/** The six columns the credential workbook must contain, in this order. */
const CREDENTIAL_COLUMNS = [
  'account_id',
  'email',
  'password',
  'company_name',
  'domain',
  'tenant_id',
];

const FIELDS = [
  { key: 'company_name', label: 'Company name', icon: Building2, placeholder: 'Acme Corporation', autoComplete: 'organization' },
  { key: 'domain', label: 'Domain', icon: Globe, placeholder: 'acme.com', autoComplete: 'url', hint: 'Bare domain only — scopes SSO and every email identity.' },
  { key: 'email', label: 'Email', icon: Mail, placeholder: 'admin@acme.com', type: 'email', autoComplete: 'email', hint: 'Becomes the root administrator sign-in address.' },
  { key: 'first_name', label: 'First name', icon: User, placeholder: 'Ada', autoComplete: 'given-name', half: true },
  { key: 'last_name', label: 'Last name', icon: User, placeholder: 'Lovelace', autoComplete: 'family-name', half: true },
];

const FIELD_LABELS = FIELDS.reduce((acc, f) => ({ ...acc, [f.key]: f.label }), {});
const FIELD_KEYS = FIELDS.map((f) => f.key);

/** Aliases the backend may use for the same field, mapped onto our keys. */
const FIELD_ALIASES = {
  company: 'company_name',
  companyName: 'company_name',
  tenant_name: 'company_name',
  admin_email: 'email',
  firstName: 'first_name',
  lastName: 'last_name',
  admin_first_name: 'first_name',
  admin_last_name: 'last_name',
};

/** Bare, lowercase host: strips scheme, credentials, port, path and `www.`. */
function normaliseDomain(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/^[a-z][a-z0-9+.-]*:\/\//, '')
    .replace(/^[^@/]*@/, '')
    .replace(/[/?#].*$/, '')
    .replace(/:\d+$/, '')
    .replace(/^www\./, '')
    .replace(/\.$/, '');
}

/**
 * Unpack a backend validation payload into { fields, summary }.
 * Handles: string, array, { field: "msg" }, { field: ["msg", …] } and the
 * nested marshmallow shapes { json: {…} } / { body: {…} } / { errors: {…} }.
 */
function flattenApiErrors(err) {
  const payload = err?.response?.data;
  let raw = payload?.errors ?? payload?.error ?? payload?.detail ?? null;
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    // Peel one nesting level when the object is a single envelope wrapper.
    for (const wrapper of ['json', 'body', 'errors', 'data']) {
      const inner = raw[wrapper];
      if (inner && typeof inner === 'object') raw = inner;
    }
  }

  const fields = {};
  const lines = [];
  const asText = (v) =>
    Array.isArray(v) ? v.filter(Boolean).join(' ') : typeof v === 'object' ? JSON.stringify(v) : String(v);

  const push = (key, value) => {
    const text = asText(value).trim();
    if (!text) return;
    const mapped = FIELD_ALIASES[key] || key;
    if (mapped && FIELD_KEYS.includes(mapped)) {
      fields[mapped] = text;
      lines.push(`${FIELD_LABELS[mapped]}: ${text}`);
    } else {
      lines.push(key ? `${key}: ${text}` : text);
    }
  };

  if (typeof raw === 'string') lines.push(raw);
  else if (Array.isArray(raw)) raw.forEach((entry) => push(null, entry));
  else if (raw && typeof raw === 'object') {
    Object.entries(raw).forEach(([key, value]) => {
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        Object.entries(value).forEach(([inner, innerValue]) => push(inner, innerValue));
      } else {
        push(key, value);
      }
    });
  }

  return { fields, summary: lines.length ? lines.join(' · ') : null };
}

/**
 * Map a successful registration response onto the credential row.
 * `admin` carries the account + login identity, `tenant` the company record;
 * every value falls back to the sibling object so a flatter response shape
 * still produces a complete row.
 */
function toCredentialRow(result) {
  const admin = result?.admin || {};
  const tenant = result?.tenant || {};
  return {
    account_id: admin.account_id || tenant.account_id || '',
    email: admin.email || '',
    password: admin.password || '',
    company_name: tenant.company_name || '',
    domain: tenant.domain || '',
    tenant_id: tenant.tenant_id || '',
  };
}

/** Write the credential row to an .xlsx and trigger the browser download. */
function downloadCredentialsWorkbook(row) {
  const worksheet = XLSX.utils.json_to_sheet([row], { header: CREDENTIAL_COLUMNS });
  worksheet['!cols'] = CREDENTIAL_COLUMNS.map(() => ({ wch: 28 }));
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, worksheet, 'Credentials');
  const safeName = String(row.company_name || 'tenant').replace(/[^a-z0-9._-]+/gi, '_');
  XLSX.writeFile(workbook, `${safeName}_root_admin_credentials.xlsx`);
}

export default function RegisterTenantPage() {
  const toast = useToast();
  const navigate = useNavigate();

  const [form, setForm] = useState({
    company_name: '',
    domain: '',
    email: '',
    first_name: '',
    last_name: '',
  });
  const [errors, setErrors] = useState({});
  const [saving, setSaving] = useState(false);
  const [result, setResult] = useState(null);
  const [credentials, setCredentials] = useState(null);
  const [submitError, setSubmitError] = useState(null);

  const set = (key) => (e) => {
    const { value } = e.target;
    setForm((f) => ({ ...f, [key]: value }));
    setErrors((x) => ({ ...x, [key]: undefined }));
    setSubmitError(null);
  };

  // Normalise on blur so the user sees exactly what will be submitted.
  const normaliseField = (key) => () => {
    setForm((f) => {
      if (key === 'domain') return { ...f, domain: normaliseDomain(f.domain) };
      if (key === 'email') return { ...f, email: f.email.trim().toLowerCase() };
      return { ...f, [key]: f[key].trim() };
    });
  };

  const validate = (payload) => {
    const next = {};
    if (!payload.company_name) next.company_name = 'Company name is required.';
    if (!payload.domain) next.domain = 'Domain is required.';
    else if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(payload.domain)) {
      next.domain = 'Enter a bare domain, e.g. acme.com';
    }
    if (!payload.email) next.email = 'Email is required.';
    else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(payload.email)) {
      next.email = 'Enter a valid email address.';
    }
    if (!payload.first_name) next.first_name = 'First name is required.';
    if (!payload.last_name) next.last_name = 'Last name is required.';
    setErrors(next);
    return Object.keys(next).length === 0;
  };

  const submit = async (e) => {
    e.preventDefault();
    if (saving) return;
    setSubmitError(null);

    // Exact payload contract — five keys, normalised, nothing else.
    const payload = {
      company_name: form.company_name.trim(),
      domain: normaliseDomain(form.domain),
      email: form.email.trim().toLowerCase(),
      first_name: form.first_name.trim(),
      last_name: form.last_name.trim(),
    };
    setForm(payload);
    if (!validate(payload)) return;

    setSaving(true);
    try {
      const res = await identityApi.registerTenant(payload);
      const row = toCredentialRow(res);
      setResult(res);
      setCredentials(row);

      // Automatic download: the password is shown exactly once.
      try {
        downloadCredentialsWorkbook(row);
        toast.success('Registered. Credentials spreadsheet downloaded.');
      } catch {
        toast.error('Registered, but the credentials file could not download. Use "Download again".');
      }
    } catch (err) {
      // Surface the backend's field-level reasons instead of only the generic
      // "One or more fields failed validation." envelope message.
      const { fields, summary } = flattenApiErrors(err);
      if (Object.keys(fields).length) setErrors((x) => ({ ...x, ...fields }));
      const message = summary || err.userMessage || 'Registration failed. Please try again.';
      setSubmitError(message);
      toast.error(message);
    } finally {
      setSaving(false);
    }
  };

  const redownload = useCallback(() => {
    if (!credentials) return;
    downloadCredentialsWorkbook(credentials);
    toast.success('Credentials downloaded again.');
  }, [credentials, toast]);

  return (
    <div className="min-h-screen">
      <div className="flex min-h-screen w-screen flex-col md:flex-row">
        {/* ── Left marketing panel — same language as the login screen ── */}
        <div className="relative flex-1 bg-[#0f172a] p-6 text-white md:min-h-screen">
          <div
            className="absolute inset-0 opacity-[0.03]"
            aria-hidden="true"
            style={{
              backgroundImage: `
                linear-gradient(rgba(255,255,255,0.1) 1px, transparent 1px),
                linear-gradient(90deg, rgba(255,255,255,0.1) 1px, transparent 1px)
              `,
              backgroundSize: '40px 40px',
            }}
          />
          <div className="absolute inset-0 overflow-hidden" aria-hidden="true">
            <div className="absolute -left-20 -top-20 h-96 w-96 rounded-full bg-[#0ea5e9]/10 blur-3xl" />
            <div className="absolute -bottom-32 -right-32 h-[500px] w-[500px] rounded-full bg-[#0ea5e9]/5 blur-3xl" />
          </div>

          <div className="relative z-10 flex h-full flex-col">
            <div className="mt-3">
              <div className="inline-flex items-center rounded-full bg-white/10 px-4 py-2 backdrop-blur-sm">
                <Logo size="lg" variant="clean" className="!h-18 !w-auto brightness-0 invert" />
              </div>
            </div>

            <h1 className="mt-4 text-4xl font-bold leading-tight md:text-5xl lg:text-[52px]">
              <span className="text-white">Register your</span>
              <br />
              <span className="text-[#0ea5e9]">company tenant</span>
            </h1>

            <p className="mt-2 max-w-md text-base leading-relaxed text-slate-300">
              One step provisions an isolated tenant and its root administrator. Everything
              else — users, roles, policies — is created from inside the console.
            </p>

            <div className="mt-5 space-y-3">
              {[
                { icon: Building2, title: 'Isolated tenant boundary', sub: 'Your directory, your policies, your audit trail' },
                { icon: ShieldCheck, title: 'Root administrator provisioned', sub: 'Generated username and one-time password' },
                { icon: Lock, title: 'Credentials issued once', sub: 'Delivered as a spreadsheet, never shown again' },
              ].map((item) => (
                <div key={item.title} className="flex items-center gap-4">
                  <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-[#0ea5e9]/20 backdrop-blur-sm">
                    <item.icon className="h-5 w-5 text-[#0ea5e9]" />
                  </div>
                  <div>
                    <p className="text-sm font-medium text-white">{item.title}</p>
                    <p className="text-xs text-slate-400">{item.sub}</p>
                  </div>
                </div>
              ))}
            </div>

            <p className="mt-auto pt-6 text-xs text-slate-500">
              © 2026 Deep Algorithms Solutions • IAM Control Center
            </p>
          </div>
        </div>

        {/* ── Right panel — form, then the one-time credentials ── */}
        <div className="flex flex-1 items-center justify-center bg-gradient-to-br from-slate-50 to-white p-4 md:p-6">
          <div className="w-full max-w-[380px] py-6">
            <div className="mb-3 flex flex-col items-center text-center">
              <Logo size="xl" variant="topbar" className="!h-16 !w-auto" />
              <h2 className="mt-2.5 text-xl font-bold tracking-tight text-[#0f172a]">
                {credentials ? 'Tenant registered' : 'Create your tenant'}
              </h2>
              <p className="mt-0.5 text-xs text-slate-500">
                {credentials
                  ? 'Save the credentials below before you leave this page.'
                  : 'Register a company and its root administrator.'}
              </p>
            </div>

            {!credentials ? (
              <div className="rounded-xl border border-slate-200/70 bg-white p-4 shadow-[0_4px_20px_rgb(0,0,0,0.03)]">
                {submitError && (
                  <div className="mb-3 flex items-start gap-2 rounded-lg border border-rose-200 bg-rose-50 p-2.5 text-[12px] leading-snug text-rose-700">
                    <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                    <span>{submitError}</span>
                  </div>
                )}

                <form onSubmit={submit} className="space-y-2.5" noValidate>
                  <div className="grid grid-cols-2 gap-2.5">
                    {FIELDS.map((field) => (
                      <div key={field.key} className={field.half ? 'col-span-1' : 'col-span-2'}>
                        <label
                          htmlFor={field.key}
                          className="mb-1 block text-[11px] font-semibold uppercase tracking-wide text-slate-500"
                        >
                          {field.label}
                        </label>
                        <div className="relative">
                          <field.icon className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-400" />
                          <input
                            id={field.key}
                            name={field.key}
                            type={field.type || 'text'}
                            autoComplete={field.autoComplete}
                            value={form[field.key]}
                            onChange={set(field.key)}
                            onBlur={normaliseField(field.key)}
                            placeholder={field.placeholder}
                            aria-invalid={errors[field.key] ? true : undefined}
                            className={classNames(
                              'block w-full rounded-lg border bg-white py-2 pl-8 pr-3 text-[13px] text-[#0f172a] placeholder-slate-400 transition-all duration-150 focus:outline-none focus:ring-2',
                              errors[field.key]
                                ? 'border-rose-300 focus:border-rose-400 focus:ring-rose-500/15'
                                : 'border-slate-200 focus:border-[#0ea5e9] focus:ring-[#0ea5e9]/20'
                            )}
                          />
                        </div>
                        {errors[field.key] ? (
                          <p className="mt-1 text-[10.5px] font-medium text-rose-600">{errors[field.key]}</p>
                        ) : field.hint ? (
                          <p className="mt-1 text-[10px] text-slate-400">{field.hint}</p>
                        ) : null}
                      </div>
                    ))}
                  </div>

                  <div className="flex items-start gap-2 rounded-lg border border-slate-200 bg-slate-50 p-2.5">
                    <KeyRound className="mt-0.5 h-3.5 w-3.5 shrink-0 text-slate-400" />
                    <p className="text-[11px] leading-snug text-slate-500">
                      A root administrator is created with a generated password. It is shown once
                      and downloaded as a spreadsheet the moment registration succeeds.
                    </p>
                  </div>

                  <button
                    type="submit"
                    disabled={saving}
                    className={classNames(
                      'flex w-full items-center justify-center gap-2 rounded-lg px-4 py-2 text-[13px] font-semibold text-white transition-all duration-150',
                      saving
                        ? 'cursor-not-allowed bg-[#0ea5e9]/70'
                        : 'bg-gradient-to-r from-[#0ea5e9] to-[#0284c7] hover:from-[#0284c7] hover:to-[#0369a1] hover:shadow-md hover:shadow-[#0ea5e9]/25 active:scale-[0.98]'
                    )}
                  >
                    {saving ? (
                      <svg className="h-3.5 w-3.5 animate-spin" fill="none" viewBox="0 0 24 24">
                        <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                        <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                      </svg>
                    ) : (
                      <Building2 className="h-3.5 w-3.5" />
                    )}
                    {saving ? 'Registering…' : 'Register company'}
                  </button>
                </form>
              </div>
            ) : (
              /* ── Success: one-time credentials ── */
              <div className="rounded-xl border border-slate-200/70 bg-white p-4 shadow-[0_4px_20px_rgb(0,0,0,0.03)]">
                <div className="flex items-start gap-2.5 rounded-lg border border-emerald-200 bg-emerald-50 p-3">
                  <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600" />
                  <div>
                    <p className="text-[12.5px] font-semibold text-emerald-800">
                      Credentials downloaded — save them securely
                    </p>
                    <p className="mt-0.5 text-[11px] leading-snug text-emerald-700">
                      {result?.message ||
                        'Registration successful. The password will NOT be shown again.'}
                    </p>
                  </div>
                </div>

                <dl className="mt-3 divide-y divide-slate-100 rounded-lg border border-slate-200">
                  {CREDENTIAL_COLUMNS.map((key) => (
                    <div key={key} className="flex items-start justify-between gap-3 px-3 py-2">
                      <dt className="text-[11px] font-medium uppercase tracking-wide text-slate-400">
                        {key.replace(/_/g, ' ')}
                      </dt>
                      <dd
                        className={classNames(
                          'min-w-0 break-all text-right text-[12px] font-medium text-[#0f172a]',
                          (key === 'password' || key.endsWith('_id')) && 'font-mono'
                        )}
                      >
                        {credentials[key] || '—'}
                      </dd>
                    </div>
                  ))}
                </dl>

                <div className="mt-3 flex flex-col gap-2">
                  <button
                    type="button"
                    onClick={redownload}
                    className="flex w-full items-center justify-center gap-2 rounded-lg border border-slate-200 bg-white px-4 py-2 text-[12.5px] font-semibold text-[#0f172a] transition-all duration-150 hover:border-slate-300 hover:bg-slate-50 active:scale-[0.98]"
                  >
                    <Download className="h-3.5 w-3.5" />
                    Download again
                  </button>
                  <button
                    type="button"
                    onClick={() => navigate('/login')}
                    className="flex w-full items-center justify-center gap-2 rounded-lg bg-gradient-to-r from-[#0ea5e9] to-[#0284c7] px-4 py-2 text-[13px] font-semibold text-white transition-all duration-150 hover:from-[#0284c7] hover:to-[#0369a1] hover:shadow-md hover:shadow-[#0ea5e9]/25 active:scale-[0.98]"
                  >
                    Continue to sign in
                  </button>
                </div>

                <p className="mt-2.5 text-center text-[10.5px] text-slate-400">
                  Sign in with the account ID and the root administrator email above.
                </p>
              </div>
            )}

            <p className="mt-3 text-center text-[12px] text-slate-500">
              <Link
                to="/login"
                className="inline-flex items-center gap-1 font-semibold text-[#0ea5e9] transition-colors hover:text-[#0284c7]"
              >
                <ArrowLeft className="h-3 w-3" />
                Back to sign in
              </Link>
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
