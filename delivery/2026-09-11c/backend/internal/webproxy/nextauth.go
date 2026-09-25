// pam/internal/webproxy/nextauth.go
//
// NextAuth (Auth.js v4) credentials sign-in, performed server-side so the
// operator lands INSIDE the application instead of on its sign-in form.
//
// WHY THIS EXISTS. Langfuse is a Next.js app that authenticates with
// NextAuth's credentials provider. Before this, a brokered Langfuse session
// resolved to the "none" strategy: PAM proxied and recorded the session
// faithfully, and then dropped the operator on Langfuse's own sign-in page,
// where they had to type a password PAM was already holding in the vault.
// That is the exact thing a privileged-access broker exists to remove: the
// human should never see, type, or know the target credential.
//
// THE FLOW, as NextAuth v4 actually implements it (verified against the
// library itself, not from documentation):
//
//  1. GET  {base}/api/auth/csrf
//     200 {"csrfToken":"<token>"} and Set-Cookie next-auth.csrf-token=<token>|<hash>.
//     The token in the body and the hash in the cookie are checked against
//     each other on the next call, so the cookie MUST be sent back.
//
//  2. POST {base}/api/auth/callback/credentials, form-encoded, carrying that
//     cookie plus csrfToken, the credential fields, callbackUrl, and
//     json=true.
//
//     json=true is the important part. Without it NextAuth answers 302 with a
//     Location header; with it, next-auth's own handler converts the redirect
//     into a JSON {"url": ...} body (see next-auth/next/index.js,
//     NextAuthApiHandler), which is readable without following a redirect and
//     losing the Set-Cookie along the way.
//
// WHY THE STATUS CODE IS NOT THE ANSWER. Measured against next-auth v4:
//
//	good credential      200  {"url":"<callbackUrl>"}          + session cookie
//	wrong credential     401  {"url":".../error?error=CredentialsSignin"}
//	csrf not carried     200  {"url":".../signin?csrf=true"}   and NO session cookie
//
// A CSRF failure is a 200. Treating 2xx as success would have reported a
// perfectly good vaulted credential as working while handing the operator an
// unauthenticated session, so success here means one thing only: a non-empty
// NextAuth session cookie came back.
//
// Kept generic rather than named "langfuse" because nothing in it is
// Langfuse-specific: any NextAuth credentials app can select it with
// extra_config.web_auth_strategy = "nextauth_credentials". Langfuse simply
// gets it by inference (see Registry.Get).
package webproxy

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
)

const strategyNextAuth = "nextauth_credentials"

// maxAuthBodyBytes caps what is read from the target's auth endpoints. Both
// responses are tiny JSON objects; anything larger means this URL is not the
// endpoint we think it is, and reading it all would be a free memory sink
// pointed at PAM by whatever the console_url happens to name.
const maxAuthBodyBytes = 1 << 20

type NextAuthCredentialsAuthenticator struct{}

func (a *NextAuthCredentialsAuthenticator) Name() string { return strategyNextAuth }

func (a *NextAuthCredentialsAuthenticator) Login(ctx context.Context, client *http.Client, target Target) (*UpstreamState, error) {
	appBase := nextAuthAppBase(target)
	authBase := appBase + "/api/auth"

	// The cookie jar for this login only. The shared client deliberately
	// carries no jar (it is reused across resources and tenants), so the
	// handshake's cookies are threaded by hand.
	jar := map[string]string{}

	csrfToken, err := nextAuthCSRF(ctx, client, authBase, jar)
	if err != nil {
		return nil, err
	}

	form := url.Values{}
	form.Set("csrfToken", csrfToken)
	form.Set(stringOr(target.ExtraConfig, "web_username_field", "email"), target.Username)
	form.Set(stringOr(target.ExtraConfig, "web_password_field", "password"), target.Password)
	form.Set("callbackUrl", appBase+"/")
	form.Set("json", "true")
	if extra, ok := target.ExtraConfig["web_extra_login_fields"].(map[string]interface{}); ok {
		for k, v := range extra {
			form.Set(k, fmt.Sprintf("%v", v))
		}
	}

	providerID := stringOr(target.ExtraConfig, "web_auth_provider_id", "credentials")
	callbackURL := authBase + "/callback/" + url.PathEscape(providerID)
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, callbackURL, strings.NewReader(form.Encode()))
	if err != nil {
		return nil, fmt.Errorf("build nextauth sign-in request: %w", err)
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	req.Header.Set("Accept", "application/json")
	applyCookieJar(req, jar)

	resp, err := client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("nextauth sign-in request failed: %w", err)
	}
	defer resp.Body.Close()

	mergeSetCookies(jar, resp.Cookies())
	returned := nextAuthReturnedURL(resp)

	if !hasNextAuthSession(jar) {
		return nil, nextAuthLoginError(resp.StatusCode, returned, callbackURL)
	}

	// Every cookie the handshake produced is carried, not just the session
	// token: NextAuth's own client re-reads the csrf and callback-url cookies
	// for sign-out and for any credentials re-post, and an app that finds
	// them missing behaves as though it had never seen this browser.
	state := &UpstreamState{}
	for name, value := range jar {
		state.setCookie(name, value)
	}
	return state, nil
}

// nextAuthAppBase is the application's root URL, honouring a Next.js
// basePath. A deployment served under a sub-path (Langfuse's
// NEXT_PUBLIC_BASE_PATH) mounts its auth API at {base}/{basePath}/api/auth,
// and asking the bare origin there returns the app's 404 page, not JSON.
func nextAuthAppBase(target Target) string {
	base := strings.TrimRight(target.BaseURL, "/")
	if p := strings.Trim(stringOr(target.ExtraConfig, "web_base_path", ""), "/"); p != "" {
		base += "/" + p
	}
	return base
}

func nextAuthCSRF(ctx context.Context, client *http.Client, authBase string, jar map[string]string) (string, error) {
	csrfURL := authBase + "/csrf"
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, csrfURL, nil)
	if err != nil {
		return "", fmt.Errorf("build nextauth csrf request: %w", err)
	}
	req.Header.Set("Accept", "application/json")

	resp, err := client.Do(req)
	if err != nil {
		return "", fmt.Errorf("nextauth csrf request failed: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("%s did not answer NextAuth's CSRF endpoint (status %d), "+
			"check the resource's console_url points at the application's own origin "+
			"(and set extra_config.web_base_path if it is served under a sub-path)",
			csrfURL, resp.StatusCode)
	}

	mergeSetCookies(jar, resp.Cookies())

	var payload struct {
		CSRFToken string `json:"csrfToken"`
	}
	body, err := io.ReadAll(io.LimitReader(resp.Body, maxAuthBodyBytes))
	if err != nil {
		return "", fmt.Errorf("read nextauth csrf response: %w", err)
	}
	if err := json.Unmarshal(body, &payload); err != nil {
		return "", fmt.Errorf("%s answered 200 but not with NextAuth's CSRF JSON, "+
			"check console_url points at the application and not at a proxy or error page", csrfURL)
	}
	if strings.TrimSpace(payload.CSRFToken) == "" {
		return "", fmt.Errorf("%s returned an empty CSRF token, the application may be running "+
			"a NextAuth version with a different sign-in API", csrfURL)
	}
	return payload.CSRFToken, nil
}

// nextAuthReturnedURL is where NextAuth says the browser should go next: the
// JSON {"url": ...} body produced by json=true, falling back to a Location
// header for any version that ignores it. It is the only place the failure
// reason appears, so it is read on success and failure alike.
func nextAuthReturnedURL(resp *http.Response) string {
	if loc := resp.Header.Get("Location"); loc != "" {
		return loc
	}
	if !strings.Contains(resp.Header.Get("Content-Type"), "json") {
		return ""
	}
	body, err := io.ReadAll(io.LimitReader(resp.Body, maxAuthBodyBytes))
	if err != nil {
		return ""
	}
	var payload struct {
		URL string `json:"url"`
	}
	if err := json.Unmarshal(body, &payload); err != nil {
		return ""
	}
	return payload.URL
}

// nextAuthLoginError turns "no session cookie came back" into the reason an
// operator or admin can act on. The three cases are genuinely different
// remedies, and collapsing them into "login failed" sends somebody to rotate
// a credential that was never the problem.
func nextAuthLoginError(status int, returned, callbackURL string) error {
	reason, provider := nextAuthErrorParams(returned)

	switch {
	case reason == "CredentialsSignin":
		return fmt.Errorf("the application rejected the stored credential (status %d), "+
			"check the account name and password held for this resource in the vault", status)
	case reason != "":
		// A non-credentials NextAuth error: the account exists but the app
		// refused this sign-in (SSO enforced, email unverified, provider
		// disabled). Naming it verbatim is the only useful thing to do,
		// because the remedy lives in the target application's own settings.
		if provider != "" {
			return fmt.Errorf("the application refused the sign-in with NextAuth error %q on provider %q, "+
				"this is a setting in the target application rather than a credential problem", reason, provider)
		}
		return fmt.Errorf("the application refused the sign-in with NextAuth error %q, "+
			"this is a setting in the target application rather than a credential problem", reason)
	case nextAuthCSRFRejected(returned):
		return fmt.Errorf("the application rejected the sign-in CSRF token, "+
			"which usually means its cookies are being dropped between PAM and %s, "+
			"check for an intermediate proxy that strips Set-Cookie", callbackURL)
	default:
		return fmt.Errorf("%s returned no session cookie (status %d), "+
			"the application may not be using NextAuth's credentials provider, "+
			"set extra_config.web_auth_strategy explicitly if it uses a different sign-in API",
			callbackURL, status)
	}
}

func nextAuthErrorParams(returned string) (reason, provider string) {
	if returned == "" {
		return "", ""
	}
	u, err := url.Parse(returned)
	if err != nil {
		return "", ""
	}
	q := u.Query()
	return q.Get("error"), q.Get("provider")
}

func nextAuthCSRFRejected(returned string) bool {
	if returned == "" {
		return false
	}
	u, err := url.Parse(returned)
	if err != nil {
		return false
	}
	return u.Query().Get("csrf") == "true"
}

// ── cookie plumbing ───────────────────────────────────────────────────────

func applyCookieJar(req *http.Request, jar map[string]string) {
	for name, value := range jar {
		req.AddCookie(&http.Cookie{Name: name, Value: value})
	}
}

// mergeSetCookies applies a response's Set-Cookie headers to the jar,
// honouring deletions. NextAuth CLEARS the session cookie on a failed
// sign-in (empty value, MaxAge<0); keeping that empty cookie would make
// hasNextAuthSession true and report a failed login as a success.
func mergeSetCookies(jar map[string]string, cookies []*http.Cookie) {
	for _, ck := range cookies {
		if ck.MaxAge < 0 || ck.Value == "" {
			delete(jar, ck.Name)
			continue
		}
		jar[ck.Name] = ck.Value
	}
}

func hasNextAuthSession(jar map[string]string) bool {
	for name, value := range jar {
		if value != "" && isNextAuthSessionCookie(name) {
			return true
		}
	}
	return false
}

// isNextAuthSessionCookie matches every shape the session cookie's name
// takes in the wild. It is NOT a fixed string: NextAuth prefixes "__Secure-"
// when the deployment is HTTPS, and Langfuse appends a suffix of its own
// (getCookieName in web/src/server/utils/cookies.ts adds ".<region>" or
// ".<NEXTAUTH_COOKIE_NAME_SUFFIX>"). Matching only "next-auth.session-token"
// would work on a local HTTP test target and then fail on every real HTTPS
// deployment, which is the worst possible place to find out.
func isNextAuthSessionCookie(name string) bool {
	trimmed := name
	for _, prefix := range []string{"__Secure-", "__Host-"} {
		trimmed = strings.TrimPrefix(trimmed, prefix)
	}
	return strings.HasPrefix(trimmed, "next-auth.session-token") ||
		strings.HasPrefix(trimmed, "authjs.session-token")
}
