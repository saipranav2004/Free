import { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import {
  ArrowLeft, Pencil, ShieldCheck, Users, FileLock2, KeyRound, RotateCcw, UserX,
  Plus, Trash2, AlertCircle,
} from 'lucide-react';
import { useAuth } from '../../context/AuthContext.jsx';
import { useToast } from '../../context/ToastContext.jsx';
import { useResource } from '../../hooks/useResource.js';
import { identityApi } from '../../lib/api/identity.js';
import { rbacApi } from '../../lib/api/rbac.js';
import { pbacApi } from '../../lib/api/pbac.js';
import { PageHeader } from '../../components/common/PageHeader.jsx';
import { Card, Button, Input, Spinner, StatusBadge, Badge, Tabs, SearchableCombobox } from '../../components/ui/primitives.jsx';
import { Modal } from '../../components/ui/Modal.jsx';
import { ConfirmDialog } from '../../components/ui/ConfirmDialog.jsx';
import { EmptyState } from '../../components/ui/primitives.jsx';
import { formatDateTime, shortId, classNames } from '../../utils/format.js';

// Resolve a user object (or null on failure) to a human-friendly display name.
function displayName(u) {
  if (!u) return null;
  const full = [u.first_name, u.last_name].filter(Boolean).join(' ').trim();
  return full || u.username || u.email || u.user_id || null;
}

/**
 * Normalise a user payload.
 *
 * Bug fix: the identity API returns the row either flat
 * (`{ user_id, first_name, … }`) or wrapped (`{ user: { … } }`) depending on
 * the route, and some deployments emit `given_name` / `family_name`. The
 * profile section read `data.first_name` directly, so a wrapped or
 * alternatively-named payload rendered an em dash for First / Last name even
 * though the values were present. Flatten and alias both shapes here, once.
 */
function normaliseUser(payload) {
  if (!payload || typeof payload !== 'object') return {};
  const inner =
    payload.user && typeof payload.user === 'object' && !Array.isArray(payload.user)
      ? payload.user
      : null;
  const flat = inner ? { ...payload, ...inner } : { ...payload };
  return {
    ...flat,
    first_name: flat.first_name ?? flat.given_name ?? flat.firstName ?? '',
    last_name: flat.last_name ?? flat.family_name ?? flat.lastName ?? '',
  };
}

/** First value that is actually present (non-empty string / non-null). */
const pickFirst = (...values) => {
  for (const v of values) if (v !== undefined && v !== null && String(v).trim() !== '') return v;
  return '';
};

/* ── Profile display cache ───────────────────────────────────────────────
   Bug fix (first / last name blank after a page reload):
   the tenant detail route does not always echo first_name / last_name back
   in its GET payload, so a value that saved correctly rendered as an em dash
   on the next load. The page now resolves the profile from three sources in
   priority order — the detail route, the directory row from the users LIST
   route (which does carry the names), and finally the last values this
   browser successfully saved. The cache is a DISPLAY fallback only: it fills
   blanks, never overrides a value the API returned. */
const PROFILE_CACHE_KEY = 'iam-user-profile-cache';

function readProfileCache(userId) {
  try {
    const all = JSON.parse(window.localStorage.getItem(PROFILE_CACHE_KEY) || '{}');
    return (userId && all[userId]) || {};
  } catch {
    return {};
  }
}

function writeProfileCache(userId, profile) {
  if (!userId) return;
  try {
    const all = JSON.parse(window.localStorage.getItem(PROFILE_CACHE_KEY) || '{}');
    all[userId] = { ...(all[userId] || {}), ...profile };
    window.localStorage.setItem(PROFILE_CACHE_KEY, JSON.stringify(all));
  } catch {
    /* storage unavailable (private mode / quota) — the API remains the source of truth */
  }
}

// Tolerant field extraction — the backend may return flat rows
// ({ role_name }) or nested ones ({ role: { role_name } }), and either
// `role_id`/`policy_id` or a generic `id`.
const roleName = (r) => r?.role_name ?? r?.name ?? r?.role?.role_name ?? r?.role?.name ?? '—';
const roleId = (r) => r?.role_id ?? r?.role?.role_id ?? r?.id;
const policyName = (p) => p?.policy_name ?? p?.name ?? p?.policy?.policy_name ?? p?.policy?.name ?? 'Policy';
const policyId = (p) => p?.policy_id ?? p?.policy?.policy_id ?? p?.id;
const attachmentId = (a) => a?.attachment_id ?? a?.policy_attachment_id ?? a?.id;

// Direct attachments come back from the API as bare stubs (no policy_name), so
// resolve the human name from a policy_id -> name map built from listPolicies.
const policyDisplayName = (p, map) => {
  if (p?.policy_name) return p.policy_name;
  if (p?.name) return p.name;
  if (p?.policy?.policy_name) return p.policy.policy_name;
  if (p?.policy_id && map?.[p.policy_id]) return map[p.policy_id];
  return 'Policy';
};

// Effective policies are computed client-side (no single backend endpoint):
// direct attachments (GET /api/v1/authz/users/<id>/policies) + each role's
// policies (GET /api/v1/authz/roles/<id>/policies).
async function loadUserPolicyView(userId) {
  const directRaw = await pbacApi.userPolicies(userId);
  const direct = Array.isArray(directRaw)
    ? directRaw
    : directRaw?.policies || directRaw?.data || directRaw?.attachments || [];

  const rolesRaw = await rbacApi.listUserRoles(userId);
  const roles = Array.isArray(rolesRaw)
    ? rolesRaw
    : rolesRaw?.roles || rolesRaw?.data || [];

  const inherited = [];
  for (const r of roles) {
    const rid = roleId(r);
    if (!rid) continue;
    try {
      const rpRaw = await rbacApi.listRolePolicies(rid);
      const rp = Array.isArray(rpRaw) ? rpRaw : rpRaw?.policies || rpRaw?.data || [];
      rp.forEach((p) => inherited.push({ ...p, _via: roleName(r) }));
    } catch {
      /* ignore a role whose policies we can't read */
    }
  }
  return { direct, inherited };
}

function combineEffective(direct, inherited) {
  const map = new Map();
  const push = (p, src) => {
    const id = policyId(p);
    if (id == null) return;
    if (!map.has(id)) map.set(id, { ...p, sources: [] });
    if (!map.get(id).sources.includes(src)) map.get(id).sources.push(src);
  };
  inherited.forEach((p) => push(p, p._via ? `via ${p._via}` : 'role'));
  direct.forEach((p) => push(p, 'Direct'));
  return [...map.values()];
}

function ErrorBox({ msg }) {
  return (
    <div className="flex items-start gap-2 rounded-lg border border-rose-200 bg-rose-50 p-3 text-sm text-rose-700">
      <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
      <span>{msg || 'Failed to load.'}</span>
    </div>
  );
}

export default function UserDetailPage() {
  const { userId } = useParams();
  const { accountId } = useAuth();
  const navigate = useNavigate();
  const toast = useToast();

  const [tab, setTab] = useState('profile');
  const [busy, setBusy] = useState(false);

  const [editOpen, setEditOpen] = useState(false);
  const [form, setForm] = useState({});
  // Locally-applied profile edit, so the profile section reflects a successful
  // save immediately instead of waiting on (or being lost by) the refetch.
  const [profileOverride, setProfileOverride] = useState(null);

  const [detachRoleOpen, setDetachRoleOpen] = useState(false);
  const [roleToDetach, setRoleToDetach] = useState(null);
  const [addRoleOpen, setAddRoleOpen] = useState(false);
  const [selectedRoleId, setSelectedRoleId] = useState('');

  const [removeGroupOpen, setRemoveGroupOpen] = useState(false);
  const [groupToRemove, setGroupToRemove] = useState(null);
  const [addGroupOpen, setAddGroupOpen] = useState(false);
  const [selectedGroupId, setSelectedGroupId] = useState('');

  const [detachPolicyOpen, setDetachPolicyOpen] = useState(false);
  const [policyToDetach, setPolicyToDetach] = useState(null);
  const [attachPolicyOpen, setAttachPolicyOpen] = useState(false);
  const [selectedPolicyId, setSelectedPolicyId] = useState('');
  const [attachExpiry, setAttachExpiry] = useState('');

  const user = useResource(
    () => (accountId ? identityApi.getUser(userId, accountId) : Promise.resolve(null)),
    [userId, accountId]
  );
  const rolesRes = useResource(() => rbacApi.listUserRoles(userId), [userId]);
  // Bug fix: Always fetch policy view data so the tab count is accurate.
  // Previously this only fetched when tab === 'policies', causing the count
  // to show 0 until the user clicked the Policies tab.
  const policyView = useResource(
    () => loadUserPolicyView(userId),
    [userId]
  );
  const availableRoles = useResource(() => rbacApi.listRoles(), []);
  const availableGroups = useResource(
    () => (accountId ? identityApi.listGroups(accountId) : Promise.resolve(null)),
    [accountId]
  );
  const allPolicies = useResource(() => pbacApi.listPolicies(), []);

  // Directory fallback for the profile fields (see PROFILE_CACHE_KEY above):
  // the LIST route returns first_name / last_name even where the detail route
  // omits them.
  const directory = useResource(
    () =>
      accountId
        ? identityApi.listUsers({ account_id: accountId, page: 1, per_page: 200 })
        : Promise.resolve(null),
    [accountId]
  );

  // A different user means a previous local profile edit no longer applies.
  useEffect(() => setProfileOverride(null), [userId]);

  /* ── Resolve the profile ────────────────────────────────────────────────
     Detail route → directory row → cached last-saved values, with the edit
     just made in this session (profileOverride) always winning. Non-profile
     fields (status, timestamps, groups…) come from the detail route only. */
  const apiProfile = normaliseUser(user.data);
  const directoryRow = normaliseUser(
    (directory.data?.users || directory.data?.data?.users || []).find(
      (u) => u.user_id === userId
    )
  );
  const cachedProfile = readProfileCache(userId);

  const data = {
    ...directoryRow,
    ...apiProfile,
    first_name: pickFirst(
      profileOverride?.first_name,
      apiProfile.first_name,
      directoryRow.first_name,
      cachedProfile.first_name
    ),
    last_name: pickFirst(
      profileOverride?.last_name,
      apiProfile.last_name,
      directoryRow.last_name,
      cachedProfile.last_name
    ),
    email: pickFirst(profileOverride?.email, apiProfile.email, directoryRow.email),
    department: pickFirst(
      profileOverride?.department,
      apiProfile.department,
      directoryRow.department,
      cachedProfile.department
    ),
    title: pickFirst(
      profileOverride?.title,
      apiProfile.title,
      directoryRow.title,
      cachedProfile.title
    ),
  };
  const rolesList = rolesRes.data || [];
  const groups = data.groups || [];
  const directList = policyView.data?.direct || [];
  const inheritedList = policyView.data?.inherited || [];
  const effective = combineEffective(directList, inheritedList);

  // Defensive array checks for potential API envelope variants
  const roleOptions = Array.isArray(availableRoles.data)
    ? availableRoles.data
    : availableRoles.data?.roles || availableRoles.data?.data || [];

  const groupOptions = Array.isArray(availableGroups.data)
    ? availableGroups.data
    : availableGroups.data?.groups || availableGroups.data?.data || [];

  const policyOptions = Array.isArray(allPolicies.data)
    ? allPolicies.data
    : allPolicies.data?.policies || allPolicies.data?.data || [];

  // ── Build combobox option arrays ──
  const roleComboboxOptions = roleOptions
    .filter((r) => !rolesList.some((x) => roleId(x) === roleId(r)))
    .map((r) => ({ id: roleId(r), label: roleName(r), description: r.description }));

  const groupComboboxOptions = groupOptions
    .filter((g) => !groups.some((x) => x.group_id === g.group_id))
    .map((g) => ({ id: g.group_id, label: g.group_name, description: g.description }));

  const policyComboboxOptions = policyOptions.map((p) => ({
    id: p.policy_id,
    label: p.policy_name,
    description: p.description,
    badge: p.status,
  }));

  const attachKey = accountId
    ? [...new Set(directList.map((a) => a?.attached_by).filter(Boolean))]
      .sort()
      .join(',')
    : '';

  const attachedByMap = useResource(async () => {
    if (!attachKey) return {};
    const entries = await Promise.all(
      attachKey.split(',').map((id) =>
        identityApi
          .getUser(id, accountId)
          .then((u) => [id, displayName(u)])
          .catch(() => [id, null])
      )
    );
    return Object.fromEntries(entries);
  }, [attachKey, accountId]);

  const policyNameMap = {};
  policyOptions.forEach((p) => {
    const id = policyId(p);
    if (id) policyNameMap[id] = policyName(p);
  });

  // ---------- handlers: profile ----------
  const openEdit = () => {
    setForm({
      first_name: data.first_name || '',
      last_name: data.last_name || '',
      email: data.email || '',
      department: data.department || '',
      title: data.title || '',
    });
    setEditOpen(true);
  };

  const save = async (e) => {
    e.preventDefault();
    try {
      const res = await identityApi.updateUser(userId, accountId, form);
      // Prefer the row the backend echoes back; fall back to what was
      // submitted so the profile never shows stale values after a save.
      const updated = normaliseUser(res);
      setProfileOverride({
        first_name: updated.first_name || form.first_name || '',
        last_name: updated.last_name || form.last_name || '',
        email: updated.email || form.email || '',
        department: updated.department ?? form.department ?? '',
        title: updated.title ?? form.title ?? '',
      });
      // Remember what was saved so a reload still shows it even if the detail
      // route omits these fields from its response.
      writeProfileCache(userId, {
        first_name: updated.first_name || form.first_name || '',
        last_name: updated.last_name || form.last_name || '',
        department: updated.department ?? form.department ?? '',
        title: updated.title ?? form.title ?? '',
      });
      toast.success('User updated.');
      setEditOpen(false);
      user.reload();
      directory.reload();
    } catch (err) { toast.error(err.userMessage || 'Update failed.'); }
  };

  const setStatus = async (status) => {
    try {
      if (status === 'ACTIVE') await identityApi.enableUser(userId, accountId);
      else await identityApi.disableUser(userId, accountId);
      toast.success(`User ${status.toLowerCase()}.`);
      user.reload();
    } catch (err) { toast.error(err.userMessage || 'Action failed.'); }
  };

  const offboard = async () => {
    try {
      await identityApi.offboardUser(userId);
      toast.success('User offboarded — all access revoked.');
      user.reload();
    } catch (err) { toast.error(err.userMessage || 'Offboarding failed.'); }
  };

  // ---------- handlers: roles ----------
  const confirmDetachRole = async () => {
    setBusy(true);
    try {
      await rbacApi.revokeRoleFromUser(roleToDetach.assignment_id);
      toast.success('Role detached.');
      setDetachRoleOpen(false);
      setRoleToDetach(null);
      rolesRes.reload();
    } catch (err) { toast.error(err.userMessage || 'Could not detach role.'); }
    finally { setBusy(false); }
  };

  const addRole = async (e) => {
    e.preventDefault();
    if (!selectedRoleId) return;
    setBusy(true);
    try {
      await rbacApi.assignRoleToUser(selectedRoleId, userId);
      toast.success('Role assigned.');
      setAddRoleOpen(false);
      setSelectedRoleId('');
      rolesRes.reload();
    } catch (err) { toast.error(err.userMessage || 'Could not assign role.'); }
    finally { setBusy(false); }
  };

  // ---------- handlers: groups ----------
  const confirmRemoveGroup = async () => {
    setBusy(true);
    try {
      await identityApi.removeGroupMember(accountId, groupToRemove.group_id, userId);
      toast.success('Removed from group.');
      setRemoveGroupOpen(false);
      setGroupToRemove(null);
      user.reload();
    } catch (err) { toast.error(err.userMessage || 'Could not remove from group.'); }
    finally { setBusy(false); }
  };

  const addGroup = async (e) => {
    e.preventDefault();
    if (!selectedGroupId) return;
    setBusy(true);
    try {
      await identityApi.addGroupMember(accountId, selectedGroupId, userId);
      toast.success('Added to group.');
      setAddGroupOpen(false);
      setSelectedGroupId('');
      user.reload();
    } catch (err) { toast.error(err.userMessage || 'Could not add to group.'); }
    finally { setBusy(false); }
  };

  // ---------- handlers: policies ----------
  const confirmDetachPolicy = async () => {
    setBusy(true);
    try {
      await pbacApi.detachPolicyFromUser(policyToDetach.attachment_id);
      toast.success('Policy detached.');
      setDetachPolicyOpen(false);
      setPolicyToDetach(null);
      policyView.reload();
    } catch (err) { toast.error(err.userMessage || 'Could not detach policy.'); }
    finally { setBusy(false); }
  };  const attachPolicy = async (e) => {
    e.preventDefault();
    if (!selectedPolicyId) return;
    setBusy(true);
    try {
      await pbacApi.attachPolicyToUser({
        policy_id: selectedPolicyId,
        user_id: userId,
        expires_at: attachExpiry ? new Date(attachExpiry).toISOString() : null,
      });
      toast.success('Policy attached.');
      setAttachPolicyOpen(false);
      setSelectedPolicyId('');
      setAttachExpiry('');
      policyView.reload();
    } catch (err) { toast.error(err.userMessage || 'Could not attach policy.'); }
    finally { setBusy(false); }
  };


  if (user.loading) {
    return <div className="flex justify-center py-24"><Spinner className="h-8 w-8" /></div>;
  }

  return (
    <div>
      <button
        onClick={() => navigate('/identity/users')}
        className="mb-4 inline-flex items-center gap-1.5 text-sm text-slate-500 hover:text-ink-700"
      >
        <ArrowLeft className="h-4 w-4" /> Users
      </button>

      <PageHeader
        title={data.username || data.email}
        description={data.email}
        actions={
          <>
            <Button variant="secondary" onClick={openEdit}><Pencil className="h-4 w-4" /> Edit</Button>
            {data.status === 'ACTIVE' ? (
              <Button variant="danger" onClick={() => setStatus('DISABLED')}><UserX className="h-4 w-4" /> Disable</Button>
            ) : (
              <Button variant="outline" onClick={() => setStatus('ACTIVE')}><RotateCcw className="h-4 w-4" /> Enable</Button>
            )}
            <Button variant="danger" onClick={offboard}><UserX className="h-4 w-4" /> Offboard</Button>
          </>
        }
      />

      <div className="mb-5 flex flex-wrap items-center gap-2">
        <StatusBadge status={data.status} />
        {data.account_type && <Badge tone="brand">{data.account_type}</Badge>}
        {data.created_at && (
          <span className="text-xs text-slate-400">Created {formatDateTime(data.created_at)}</span>
        )}
      </div>

      <Tabs
        tabs={[
          { id: 'profile', label: 'Profile' },
          { id: 'roles', label: 'Roles', count: rolesList.length },
          { id: 'groups', label: 'Groups', count: groups.length },
          { id: 'policies', label: 'Policies', count: effective.length },
        ]}
        active={tab}
        onChange={setTab}
      />

      <div className="mt-5">
        {tab === 'profile' && (
          <Card className="p-5">
            <dl className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <Field label="First name" value={data.first_name} />
              <Field label="Last name" value={data.last_name} />
              <Field label="Email" value={data.email} />
              <Field label="Department" value={data.department} />
              <Field label="Title" value={data.title} />
              <Field label="Last login" value={formatDateTime(data.last_login_at)} />
            </dl>
          </Card>
        )}

        {/* ----------------------------- ROLES ----------------------------- */}
        {tab === 'roles' && (
          <Card className="p-5">
            <SectionHeader
              icon={ShieldCheck}
              title="Roles assigned"
              action={<Button size="sm" onClick={() => setAddRoleOpen(true)}><Plus className="h-4 w-4" /> Assign</Button>}
            />
            {rolesRes.loading ? (
              <div className="flex justify-center py-10"><Spinner className="h-6 w-6" /></div>
            ) : rolesRes.error ? (
              <ErrorBox msg={rolesRes.error} />
            ) : rolesList.length ? (
              <ul className="divide-y divide-line-soft">
                {rolesList.map((r) => {
                  const aid = r.assignment_id ?? r.user_role_id ?? roleId(r);
                  return (
                    <li key={roleId(r) ?? aid} className="flex items-center justify-between gap-2 py-2.5">
                      <div className="flex items-center gap-2">
                        <ShieldCheck className="h-4 w-4 text-brand-600" />
                        <span className="text-sm font-medium text-ink-800">{roleName(r)}</span>
                        <span className="text-xs text-slate-400">{r?.description}</span>
                      </div>
                      <Button
                        variant="ghost" size="sm"
                        onClick={() => { setRoleToDetach({ ...r, assignment_id: aid }); setDetachRoleOpen(true); }}
                      >
                        <Trash2 className="h-4 w-4" /> Detach
                      </Button>
                    </li>
                  );
                })}
              </ul>
            ) : (
              <EmptyState icon={ShieldCheck} title="No roles assigned" />
            )}
          </Card>
        )}

        {/* ----------------------------- GROUPS ----------------------------- */}
        {tab === 'groups' && (
          <Card className="p-5">
            <SectionHeader
              icon={Users}
              title="Group memberships"
              action={<Button size="sm" onClick={() => setAddGroupOpen(true)}><Plus className="h-4 w-4" /> Add</Button>}
            />
            {groups.length ? (
              <ul className="divide-y divide-line-soft">
                {groups.map((g) => (
                  <li key={g.group_id} className="flex items-center justify-between gap-2 py-2.5">
                    <div className="flex items-center gap-2">
                      <Users className="h-4 w-4 text-brand-600" />
                      <span className="text-sm font-medium text-ink-800">{g.group_name}</span>
                      <span className="text-xs text-slate-400">{g.description}</span>
                    </div>
                    <Button
                      variant="ghost" size="sm"
                      onClick={() => { setGroupToRemove(g); setRemoveGroupOpen(true); }}
                    >
                      <Trash2 className="h-4 w-4" /> Remove
                    </Button>
                  </li>
                ))}
              </ul>
            ) : (
              <EmptyState icon={Users} title="No group memberships" />
            )}
          </Card>
        )}

        {/* ----------------------------- POLICIES ----------------------------- */}
        {tab === 'policies' && (
          <div className="space-y-5">
            <Card className="p-5">
              <SectionHeader
                icon={FileLock2}
                title="Effective Policies"
              />
              {policyView.loading ? (
                <div className="flex justify-center py-10"><Spinner className="h-6 w-6" /></div>
              ) : policyView.error ? (
                <ErrorBox msg={policyView.error} />
              ) : effective.length ? (
                <div className="space-y-3">
                  {effective.map((p, i) => (
                    <PolicyDoc
                      key={policyId(p) ?? i}
                      name={policyDisplayName(p, policyNameMap)}
                      doc={p.policy_document}
                      sources={p.sources}
                      attachment={p.attached_by ? p : null}
                      attachedByName={p.attached_by ? (attachedByMap.data?.[p.attached_by] || null) : null}
                    />
                  ))}
                </div>
              ) : (
                <EmptyState icon={FileLock2} title="No effective policies" description="Assign roles or attach policies directly to grant access." />
              )}
            </Card>

            <Card className="p-5">
              <SectionHeader
                icon={KeyRound}
                title="Direct Policy Attachments"
                action={<Button size="sm" onClick={() => setAttachPolicyOpen(true)}><Plus className="h-4 w-4" /> Attach</Button>}
              />
              {policyView.loading ? (
                <div className="flex justify-center py-10"><Spinner className="h-6 w-6" /></div>
              ) : policyView.error ? (
                <ErrorBox msg={policyView.error} />
              ) : directList.length ? (
                <ul className="divide-y divide-line-soft">
                  {directList.map((a, i) => {
                    const aid = attachmentId(a);
                    const pid = policyId(a);
                    const byName = a.attached_by ? (attachedByMap.data?.[a.attached_by] || null) : null;
                    return (
                      <li
                        key={aid ?? i}
                        className="flex flex-col gap-3 py-3 sm:flex-row sm:items-center sm:justify-between"
                      >
                        <div className="min-w-0">
                          <div className="flex items-center gap-2">
                            <FileLock2 className="h-4 w-4 shrink-0 text-brand-600" />
                            <span className="truncate text-sm font-semibold text-ink-800">{policyDisplayName(a, policyNameMap)}</span>
                          </div>
                          <dl className="mt-2 grid grid-cols-1 gap-x-6 gap-y-1 text-xs sm:grid-cols-2">
                            <Meta
                              label="Policy ID"
                              value={a.policy_id ? shortId(a.policy_id) : '—'}
                              mono
                              title={a.policy_id}
                            />
                            <Meta
                              label="Attachment ID"
                              value={aid ? shortId(aid) : '—'}
                              mono
                              title={aid}
                            />
                            <Meta
                              label="Attached by"
                              value={byName || (a.attached_by ? shortId(a.attached_by) : '—')}
                              title={a.attached_by}
                            />
                            <Meta label="Attached at" value={formatDateTime(a.attached_at)} />
                          </dl>
                          {a.expires_at && (
                            <p className="mt-1 text-xs text-slate-400">Expires {formatDateTime(a.expires_at)}</p>
                          )}
                        </div>
                        <div className="flex shrink-0 self-start gap-2 sm:self-center">
                          <Button
                            variant="ghost" size="sm"
                            onClick={() => { setPolicyToDetach({ ...a, attachment_id: aid }); setDetachPolicyOpen(true); }}
                          >
                            <Trash2 className="h-4 w-4" /> Detach
                          </Button>
                        </div>
                      </li>
                    );
                  })}
                </ul>
              ) : (
                <EmptyState icon={KeyRound} title="No direct policy attachments" />
              )}
            </Card>
          </div>
        )}
      </div>

      {/* ----------------------------- MODALS / DIALOGS ----------------------------- */}
      <Modal open={editOpen} onClose={() => setEditOpen(false)} title="Edit user" size="form"
        footer={<><Button variant="secondary" onClick={() => setEditOpen(false)}>Cancel</Button><Button onClick={save}>Save</Button></>}>
        <form onSubmit={save} className="space-y-4">
          <Input label="First name" value={form.first_name} onChange={(e) => setForm((f) => ({ ...f, first_name: e.target.value }))} />
          <Input label="Last name" value={form.last_name} onChange={(e) => setForm((f) => ({ ...f, last_name: e.target.value }))} />
          <Input label="Email" type="email" value={form.email} onChange={(e) => setForm((f) => ({ ...f, email: e.target.value }))} />
          <Input label="Department" value={form.department} onChange={(e) => setForm((f) => ({ ...f, department: e.target.value }))} />
          <Input label="Title" value={form.title} onChange={(e) => setForm((f) => ({ ...f, title: e.target.value }))} />
        </form>
      </Modal>

      {/* Assign Role — searchable combobox */}
      <Modal open={addRoleOpen} onClose={() => setAddRoleOpen(false)} title="Assign role" size="form"
        footer={<><Button variant="secondary" onClick={() => setAddRoleOpen(false)}>Cancel</Button><Button onClick={addRole} loading={busy}>Assign</Button></>}>
        <form onSubmit={addRole} className="space-y-4">
          <SearchableCombobox
            label="Role"
            options={roleComboboxOptions}
            value={selectedRoleId}
            onChange={setSelectedRoleId}
            placeholder="Choose a role…"
            searchPlaceholder="Search by name…"
            loading={availableRoles.loading}
            hint="Select a role to assign to this user."
          />
        </form>
      </Modal>

      {/* Add to Group — searchable combobox */}
      <Modal open={addGroupOpen} onClose={() => setAddGroupOpen(false)} title="Add to group" size="form"
        footer={<><Button variant="secondary" onClick={() => setAddGroupOpen(false)}>Cancel</Button><Button onClick={addGroup} loading={busy}>Add</Button></>}>
        <form onSubmit={addGroup} className="space-y-4">
          <SearchableCombobox
            label="Group"
            options={groupComboboxOptions}
            value={selectedGroupId}
            onChange={setSelectedGroupId}
            placeholder="Choose a group…"
            searchPlaceholder="Search by name…"
            loading={availableGroups.loading}
            hint="Select a group to add this user to."
          />
        </form>
      </Modal>

      {/* Attach Policy — searchable combobox */}
      <Modal
        open={attachPolicyOpen}
        onClose={() => { setAttachPolicyOpen(false); setSelectedPolicyId(''); setAttachExpiry(''); }}
        title="Attach policy"
        size="form"
        footer={
          <>
            <Button variant="secondary" onClick={() => { setAttachPolicyOpen(false); setSelectedPolicyId(''); setAttachExpiry(''); }}>Cancel</Button>
            <Button onClick={attachPolicy} loading={busy}>Attach</Button>
          </>
        }
      >
        <form onSubmit={attachPolicy} className="space-y-4">
          <SearchableCombobox
            label="Policy"
            options={policyComboboxOptions}
            value={selectedPolicyId}
            onChange={setSelectedPolicyId}
            placeholder="Choose a policy…"
            searchPlaceholder="Search by name or description…"
            loading={allPolicies.loading}
            hint="Select a policy to attach to this user."
          />
          <Input
            label="Expires at (optional)"
            type="datetime-local"
            value={attachExpiry}
            onChange={(e) => setAttachExpiry(e.target.value)}
          />
          <p className="text-xs text-slate-400">
            Leave empty for no expiration. When set, the policy will be automatically revoked after this date.
          </p>
        </form>
      </Modal>

      <ConfirmDialog
        open={detachRoleOpen} onClose={() => setDetachRoleOpen(false)} onConfirm={confirmDetachRole}
        danger loading={busy} title="Detach role"
        message={`Remove the "${roleName(roleToDetach)}" role from this user?`}
      />
      <ConfirmDialog
        open={removeGroupOpen} onClose={() => setRemoveGroupOpen(false)} onConfirm={confirmRemoveGroup}
        danger loading={busy} title="Remove from group"
        message={`Remove this user from "${groupToRemove?.group_name}"?`}
      />
      <ConfirmDialog
        open={detachPolicyOpen} onClose={() => setDetachPolicyOpen(false)} onConfirm={confirmDetachPolicy}
        danger loading={busy} title="Detach policy"
        message={`Detach the "${policyDisplayName(policyToDetach, policyNameMap)}" policy from this user?`}
      />


    </div>
  );
}

/* ----------------------------- helpers ----------------------------- */
function Field({ label, value }) {
  return (
    <div>
      <dt className="text-xs text-slate-400">{label}</dt>
      <dd className="text-sm font-medium text-ink-800">{value || '—'}</dd>
    </div>
  );
}

function SectionHeader({ icon: Icon, title, subtitle, action }) {
  return (
    <div className="mb-3 flex items-center justify-between">
      <div className="flex items-center gap-2">
        {Icon && <Icon className="h-4 w-4 text-brand-600" />}
        <div>
          <h3 className="text-[13.5px] font-semibold text-ink-900">{title}</h3>
          {subtitle && <p className="text-xs text-slate-400">{subtitle}</p>}
        </div>
      </div>
      {action}
    </div>
  );
}

/**
 * PolicyDoc — renders a single effective policy card with source badges
 * and attachment metadata.
 *
 * Enterprise pattern: Each policy shows its source(s) (Direct vs via Role)
 * and attachment details when available.
 */
function PolicyDoc({ name, doc, sources, attachment, attachedByName }) {
  const docIsAttachment =
    doc && typeof doc === 'object' && !Array.isArray(doc) &&
    ('attachment_id' in doc || 'attached_at' in doc || 'attached_by' in doc || 'user_id' in doc);
  const att = attachment || (docIsAttachment ? doc : null);
  const hasDoc =
    doc && typeof doc === 'object' && !Array.isArray(doc) &&
    (doc.Action || doc.Statement || doc.Version || doc.Resource);

  return (
    <div className="rounded-lg border border-line p-3 dark:border-slate-700">
      <div className="flex items-center justify-between gap-2">
        <p className="text-sm font-medium text-ink-900">{name}</p>
        <div className="flex items-center gap-2">
          {sources?.length ? (
            <div className="flex flex-wrap gap-1">
              {sources.map((s, i) => (
                <Badge key={i} tone={s === 'Direct' ? 'brand' : 'slate'}>{s}</Badge>
              ))}
            </div>
          ) : null}
        </div>
      </div>

      {att ? (
        <dl className="mt-2 grid grid-cols-1 gap-x-6 gap-y-1 text-xs sm:grid-cols-2">
          <Meta
            label="Policy ID"
            value={att.policy_id ? shortId(att.policy_id) : '—'}
            mono
            title={att.policy_id}
          />
          <Meta
            label="Attachment ID"
            value={att.attachment_id ? shortId(att.attachment_id) : '—'}
            mono
            title={att.attachment_id}
          />
          <Meta
            label="Attached by"
            value={attachedByName || (att.attached_by ? shortId(att.attached_by) : '—')}
            title={att.attached_by}
          />
          <Meta label="Attached at" value={formatDateTime(att.attached_at)} />
        </dl>
      ) : hasDoc ? (
        <pre className="mt-2 overflow-auto rounded bg-ink-900 p-2 text-xs text-emerald-200 dark:bg-black/40">
          {JSON.stringify(doc, null, 2)}
        </pre>
      ) : null}

    </div>
  );
}

function Meta({ label, value, mono, title }) {
  return (
    <div className="flex min-w-0 gap-2">
      <dt className="shrink-0 text-black-400">{label}</dt>
      <dd
        className={classNames(
          'truncate font-medium text-ink-700 dark:text-black-200',
          mono && 'font-mono'
        )}
        title={title || value}
      >
        {value}
      </dd>
    </div>
  );
}