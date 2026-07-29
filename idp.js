/**
 * IDP (AdapID) API client — a SEPARATE service from the IAM backend.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHY ITS OWN CLIENT
 * ═══════════════════════════════════════════════════════════════════════════
 * Identity-provider federation runs as its own product on its own host (the
 * AdapID Flask app), with its own auth model and its own flat JSON shape —
 * `{ tenants: [...] }`, `{ ok, error }` — not the IAM backend's
 * `{ success, data, message }` envelope. Mixing the two behind one axios
 * instance would mean one base URL, one interceptor and one token for two
 * unrelated services, so this module keeps its own instance driven by
 * `VITE_IDP_API_BASE_URL` and never touches `VITE_API_BASE_URL`.
 *
 * Endpoints (all confirmed against the AdapID app):
 *   GET  /api/tenants                              → { tenants: [...] }
 *   POST /api/tenants                              → { tenant: {...} }   (adopt)
 *   POST /api/tenants/check                        → { found, tenant_id, schema,
 *                                                      schema_exists, adopted,
 *                                                      record, has_secret,
 *                                                      has_certificate }
 *   POST /api/tenants/<id>/graph-credentials       → { ok }
 *   POST /api/tenants/<id>/graph-test              → { ok, sample_count, stage, detail }
 *   POST /api/tenants/<id>/sync                    → { ok, job_id }  (409 if running)
 *   GET  /api/tenants/<id>/sync/<job_id>           → { job: {...} }
 *   GET  /api/tenants/<id>/federation-status       → { has_synced, status, error }
 *   POST /api/tenants/<id>/federation              → { ok, sso_url, error }
 *   POST /api/tenants/<id>/mfa-config              → { saved, mfa_method, stepup_* }
 *   GET  /api/mfa-methods                          → { primary, stepup, modes }
 *
 * SAML endpoints are not called from the SPA — they are values the admin pastes
 * into Google/Entra — so they are exposed as URL builders instead of requests.
 */
import axios from 'axios';

/**
 * REQUEST base — where XHR actually goes.
 *
 * Default '/idp' routes through the Vite dev proxy (see vite.config.js), which
 * forwards to the AdapID host and strips the prefix. Going same-origin avoids
 * CORS entirely and keeps the UI API key off a cross-site request. Set
 * VITE_IDP_API_BASE_URL to call the service directly instead (it must then send
 * CORS headers for this origin).
 *
 * NOTE: the old default was 'http://localhost:5000' — that is the IAM Flask
 * backend, not AdapID, so every IDP call failed with "could not reach".
 */
const RAW_IDP_BASE = import.meta.env.VITE_IDP_API_BASE_URL || '/idp';
export const IDP_BASE = RAW_IDP_BASE.replace(/\/+$/, '');

/**
 * PUBLIC base — the externally reachable AdapID host.
 *
 * Kept separate from IDP_BASE on purpose: the SAML values below are pasted into
 * Google / Entra, so they must be absolute public URLs. A relative proxy prefix
 * would produce unusable endpoints like "/idp/saml/...".
 */
const RAW_PUBLIC_BASE =
  import.meta.env.VITE_IDP_PUBLIC_URL ||
  (RAW_IDP_BASE.startsWith('http') ? RAW_IDP_BASE : 'https://idp.cf.adapid.link');
export const IDP_PUBLIC_BASE = RAW_PUBLIC_BASE.replace(/\/+$/, '');

/**
 * The IdP entity id (SAML issuer) the admin pastes into the service provider.
 * The Flask templates injected this as `idp_issuer`; here it comes from the
 * environment, falling back to the public host.
 */
export const IDP_ISSUER = (import.meta.env.VITE_IDP_ISSUER || IDP_PUBLIC_BASE).replace(/\/+$/, '');

/** Platform → SAML URL segment. Entra's routes are mounted under `entraid`. */
export const platformSegment = (platform) =>
  String(platform || '').toLowerCase() === 'entra' ? 'entraid' : String(platform || '').toLowerCase();

/**
 * The five values a service provider needs, built exactly as the AdapID
 * templates built them (they embed the tenant id, so they cannot be shown
 * before a domain has been resolved to a tenant).
 */
export function samlEndpoints(platform, tenantId) {
  const seg = platformSegment(platform);
  const root = `${IDP_PUBLIC_BASE}/saml/${seg}/${tenantId}`;
  return {
    entityId: IDP_ISSUER,
    sso: `${root}/sso`,
    slo: `${root}/slo`,
    changePassword: `${root}/change-password`,
    metadata: `${root}/metadata`,
  };
}

/**
 * UI API key.
 *
 * The AdapID service authenticates the console itself (not the end user) with a
 * shared UI key, so it is sent on every IDP request. It lives in the
 * environment — never hardcoded — alongside VITE_IDP_API_BASE_URL:
 *
 *   VITE_IDP_UI_API_KEY=…
 *
 * `X-UI-API-Key` is the header the service reads; the same value is also sent as
 * `X-API-Key` so either accepted spelling resolves. Omitted entirely when the
 * variable is unset, so a local service with no key configured still works.
 */
const UI_API_KEY = import.meta.env.VITE_IDP_UI_API_KEY || '';

const idpApi = axios.create({
  baseURL: IDP_BASE,
  headers: {
    'Content-Type': 'application/json',
    ...(UI_API_KEY ? { 'X-UI-API-Key': UI_API_KEY, 'X-API-Key': UI_API_KEY } : {}),
  },
});

idpApi.interceptors.response.use(
  // AdapID answers with flat JSON; a `{ data: … }` envelope is unwrapped for
  // forward compatibility.
  (response) => {
    const body = response.data;
    if (body && typeof body === 'object' && !Array.isArray(body) && 'data' in body && 'success' in body) {
      return body.data;
    }
    return body;
  },
  (error) => {
    const data = error?.response?.data;
    const status = error?.response?.status;
    let message = error?.message || 'IDP request failed';

    if (data) {
      if (typeof data === 'string') {
        /* A gateway (CloudFront, nginx, an ELB) answers with an HTML error page,
           not JSON. Rendering that string verbatim dumped a whole DOCTYPE into
           the UI, so HTML bodies are never surfaced — they carry no actionable
           detail beyond the status code, which is reported below. */
        const looksLikeHtml = /^\s*<(?:!doctype|html)/i.test(data);
        if (!looksLikeHtml) message = data.trim().slice(0, 300);
      } else if (data.error) {
        message = data.error;
      } else if (data.message) {
        message = data.message;
      }
    }

    /* 5xx from an edge/proxy means the request arrived but the AdapID service
       behind it did not answer — an infrastructure state, not a client bug. Say
       that plainly instead of leaving the operator with a raw gateway page. */
    if (status === 502 || status === 503 || status === 504) {
      message =
        'The IDP service is not responding (HTTP ' + status + ' from the gateway). ' +
        'AdapID is up as a route but its origin is unreachable — check that the ' +
        'AdapID app is running and healthy behind ' + IDP_PUBLIC_BASE + ', then retry.';
    } else if (status >= 500) {
      message = 'The IDP service returned an internal error (HTTP ' + status + '). ' + message;
    }
    // A missing/incorrect VITE_IDP_API_BASE_URL is the single most common cause
    // of failure here, and axios only reports "Network Error" — say so plainly.
    if (status === 401 || status === 403) {
      message = UI_API_KEY
        ? 'The IDP service rejected the console UI API key. Check VITE_IDP_UI_API_KEY.'
        : 'The IDP service requires a UI API key. Set VITE_IDP_UI_API_KEY and reload.';
    }
    if (!error.response) {
      message = IDP_BASE.startsWith('http')
        ? `Could not reach the IDP service at ${IDP_BASE}. Check VITE_IDP_API_BASE_URL ` +
          '(AdapID is a separate service from the IAM backend) and that it allows this origin.'
        : `Could not reach the IDP service through the "${IDP_BASE}" dev proxy. ` +
          'Confirm vite.config.js proxies it to the AdapID host with a rewrite that ' +
          'strips the prefix, then restart the dev server.';
    }
    error.userMessage = message;
    error.isIdpUnreachable = !error.response || status === 502 || status === 503 || status === 504;
    return Promise.reject(error);
  }
);

// ─── Tenants ───

/** GET /api/tenants → the adopted tenant list. */
export async function listTenants() {
  const res = await idpApi.get('/api/tenants');
  return res?.tenants || [];
}

/** One tenant, read back from the list (the service exposes no detail route). */
export async function getTenant(tenantId) {
  const list = await listTenants();
  return list.find((t) => t.tenant_id === tenantId) || null;
}

/** POST /api/tenants/check → resolve a verified domain to its tenant. */
export async function checkDomain(domain) {
  return idpApi.post('/api/tenants/check', { domain });
}

/** POST /api/tenants → adopt (or re-adopt, which updates) a tenant. */
export async function adoptTenant(payload) {
  return idpApi.post('/api/tenants', payload);
}

// ─── Microsoft Graph (Entra only) ───

export async function saveGraphCredentials(tenantId, clientId, clientSecret) {
  return idpApi.post(`/api/tenants/${tenantId}/graph-credentials`, {
    client_id: clientId,
    client_secret: clientSecret,
  });
}

export async function testGraphConnection(tenantId, clientId, clientSecret) {
  return idpApi.post(`/api/tenants/${tenantId}/graph-test`, {
    client_id: clientId,
    client_secret: clientSecret,
  });
}

/** POST /api/tenants/<id>/sync → starts a job; 409 means one is already running. */
export async function syncDirectory(tenantId) {
  return idpApi.post(`/api/tenants/${tenantId}/sync`);
}

export async function getSyncStatus(tenantId, jobId) {
  return idpApi.get(`/api/tenants/${tenantId}/sync/${jobId}`);
}

// ─── Federation (Entra only) ───

export async function toggleFederation(tenantId, enabled) {
  return idpApi.post(`/api/tenants/${tenantId}/federation`, { enabled });
}

export async function getFederationStatus(tenantId) {
  return idpApi.get(`/api/tenants/${tenantId}/federation-status`);
}

// ─── MFA policy ───

export async function saveMfaConfig(tenantId, config) {
  return idpApi.post(`/api/tenants/${tenantId}/mfa-config`, config);
}

/** GET /api/mfa-methods → { primary: [{name,label}], stepup: [...], modes: [...] }. */
export async function getMfaMethods() {
  return idpApi.get('/api/mfa-methods');
}

export const MFA_METHOD_FALLBACK = { primary: [], stepup: [], modes: ['external', 'idp'] };

export default idpApi;
