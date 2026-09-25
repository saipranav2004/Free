// pam/internal/webproxy/nextauth_test.go
//
// The NextAuth test server below is not invented. Every response it gives was
// MEASURED against next-auth v4's own pages-API handler, driven with curl
// while building this feature:
//
//	GET  /api/auth/csrf
//	  200 {"csrfToken":"<t>"}
//	  Set-Cookie: next-auth.csrf-token=<t>%7C<hash>; Path=/; HttpOnly; SameSite=Lax
//	  Set-Cookie: next-auth.callback-url=...
//
//	POST /api/auth/callback/credentials (form-encoded, json=true)
//	  good credential  200 {"url":"<callbackUrl>"}   + Set-Cookie next-auth.session-token
//	  wrong credential 401 {"url":".../error?error=CredentialsSignin&provider=credentials"}
//	  csrf not carried 200 {"url":".../signin?csrf=true"}   and NO session cookie
//
// That third line is the whole reason these tests exist. A CSRF failure comes
// back 2xx, so an implementation that reads the status code and stops reports
// a broken sign-in as a success and hands the operator a session that is not
// signed in to anything.
package webproxy

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
)

type nextAuthServerOptions struct {
	// wantEmail/wantPassword are the credential the fake accepts.
	wantEmail, wantPassword string

	// sessionCookieName is how this deployment names the session cookie.
	// Left empty it is NextAuth's HTTP default; real HTTPS deployments add
	// "__Secure-", and Langfuse appends ".<region>" or a configured suffix.
	sessionCookieName string

	// basePath mirrors Next.js's NEXT_PUBLIC_BASE_PATH: every route,
	// /api/auth included, moves under it.
	basePath string

	// dropCSRFCookie makes the server behave like an intermediate proxy that
	// strips Set-Cookie, so the csrf token never round-trips.
	dropCSRFCookie bool

	// clearSessionOnFailure reproduces NextAuth clearing a stale session
	// cookie (empty value, Max-Age 0) on the sign-in response.
	clearSessionOnFailure bool

	// errorOverride replaces CredentialsSignin with another NextAuth error,
	// for the "the app refused this sign-in" cases (SSO enforced, and so on).
	errorOverride string

	// csrfBody replaces the CSRF response body, for the "console_url points
	// at something that is not this application" case.
	csrfBody, csrfContentType string
	csrfStatus                int
}

func (o nextAuthServerOptions) sessionCookie() string {
	if o.sessionCookieName != "" {
		return o.sessionCookieName
	}
	return "next-auth.session-token"
}

// newNextAuthTestServer stands up a NextAuth-shaped sign-in API.
func newNextAuthTestServer(t *testing.T, opts nextAuthServerOptions) *httptest.Server {
	t.Helper()

	const csrfToken = "ab7d96dd7898958f0ee1263f3dfc8d339304b1b0edd100ca6ac8ca3100eea2cc"
	const csrfCookie = csrfToken + "%7C970af7c558afe1eb19aa2abf8fcb9b3b3926bc007f8fa9350a8715e6b07cb38c"

	var srv *httptest.Server
	handler := http.NewServeMux()

	prefix := strings.TrimRight(opts.basePath, "/")

	handler.HandleFunc(prefix+"/api/auth/csrf", func(w http.ResponseWriter, r *http.Request) {
		if opts.csrfStatus != 0 {
			w.Header().Set("Content-Type", opts.csrfContentType)
			w.WriteHeader(opts.csrfStatus)
			_, _ = w.Write([]byte(opts.csrfBody))
			return
		}
		if !opts.dropCSRFCookie {
			http.SetCookie(w, &http.Cookie{Name: "next-auth.csrf-token", Value: csrfCookie, Path: "/", HttpOnly: true})
		}
		http.SetCookie(w, &http.Cookie{Name: "next-auth.callback-url", Value: url.QueryEscape(srv.URL), Path: "/", HttpOnly: true})
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]string{"csrfToken": csrfToken})
	})

	handler.HandleFunc(prefix+"/api/auth/callback/credentials", func(w http.ResponseWriter, r *http.Request) {
		if err := r.ParseForm(); err != nil {
			w.WriteHeader(http.StatusBadRequest)
			return
		}
		w.Header().Set("Content-Type", "application/json")

		// NextAuth checks the posted csrfToken against the hash in the
		// cookie, so a request that did not carry the cookie back fails the
		// handshake — and fails it with a 200.
		ck, err := r.Cookie("next-auth.csrf-token")
		if err != nil || !strings.HasPrefix(ck.Value, r.PostFormValue("csrfToken")) {
			_ = json.NewEncoder(w).Encode(map[string]string{"url": srv.URL + prefix + "/api/auth/signin?csrf=true"})
			return
		}

		ok := r.PostFormValue("email") == opts.wantEmail && r.PostFormValue("password") == opts.wantPassword
		if !ok {
			reason := "CredentialsSignin"
			if opts.errorOverride != "" {
				reason = opts.errorOverride
			}
			if opts.clearSessionOnFailure {
				http.SetCookie(w, &http.Cookie{Name: opts.sessionCookie(), Value: "", Path: "/", MaxAge: -1})
			}
			w.WriteHeader(http.StatusUnauthorized)
			_ = json.NewEncoder(w).Encode(map[string]string{
				"url": srv.URL + prefix + "/api/auth/error?error=" + reason + "&provider=credentials",
			})
			return
		}

		http.SetCookie(w, &http.Cookie{Name: opts.sessionCookie(), Value: "jwt.session.value", Path: "/", HttpOnly: true})
		http.SetCookie(w, &http.Cookie{Name: "next-auth.callback-url", Value: url.QueryEscape(srv.URL + prefix + "/"), Path: "/", HttpOnly: true})
		_ = json.NewEncoder(w).Encode(map[string]string{"url": srv.URL + prefix + "/"})
	})

	srv = httptest.NewServer(handler)
	t.Cleanup(srv.Close)
	return srv
}

// noRedirectClient matches the proxy service's own client, which stops at the
// first response rather than following redirects. Login has to work under
// that policy: a followed 302 would discard the Set-Cookie that carries the
// session.
func noRedirectClient() *http.Client {
	return &http.Client{CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
}

func TestNextAuthLoginCapturesTheSessionCookie(t *testing.T) {
	srv := newNextAuthTestServer(t, nextAuthServerOptions{wantEmail: "ops@example.com", wantPassword: "correct-horse"})

	auth := &NextAuthCredentialsAuthenticator{}
	state, err := auth.Login(context.Background(), noRedirectClient(), Target{
		BaseURL: srv.URL, Username: "ops@example.com", Password: "correct-horse",
	})
	if err != nil {
		t.Fatalf("login against a NextAuth target failed: %v", err)
	}
	if state.Cookies["next-auth.session-token"] != "jwt.session.value" {
		t.Fatalf("session cookie not captured, got %#v", state.Cookies)
	}
	// The csrf and callback-url cookies matter too: NextAuth's own client
	// re-reads them, and an app that cannot find them behaves as though it
	// had never seen this browser.
	if state.Cookies["next-auth.csrf-token"] == "" {
		t.Errorf("csrf cookie was dropped, got %#v", state.Cookies)
	}
	if state.Cookies["next-auth.callback-url"] == "" {
		t.Errorf("callback-url cookie was dropped, got %#v", state.Cookies)
	}
}

func TestNextAuthLoginBlamesTheVaultOnARejectedCredential(t *testing.T) {
	srv := newNextAuthTestServer(t, nextAuthServerOptions{wantEmail: "ops@example.com", wantPassword: "correct-horse"})

	auth := &NextAuthCredentialsAuthenticator{}
	_, err := auth.Login(context.Background(), noRedirectClient(), Target{
		BaseURL: srv.URL, Username: "ops@example.com", Password: "wrong",
	})
	if err == nil {
		t.Fatal("a wrong password must not produce a session")
	}
	if !strings.Contains(err.Error(), "vault") {
		t.Fatalf("a rejected credential should point at the stored credential, got: %v", err)
	}
}

// The case that makes every other assertion here worth writing: NextAuth
// answers a failed CSRF handshake with 200. Anything that reads the status
// code and stops calls this a successful login.
func TestNextAuthLoginTreatsA200WithNoSessionAsAFailure(t *testing.T) {
	srv := newNextAuthTestServer(t, nextAuthServerOptions{
		wantEmail: "ops@example.com", wantPassword: "correct-horse", dropCSRFCookie: true,
	})

	auth := &NextAuthCredentialsAuthenticator{}
	state, err := auth.Login(context.Background(), noRedirectClient(), Target{
		BaseURL: srv.URL, Username: "ops@example.com", Password: "correct-horse",
	})
	if err == nil {
		t.Fatalf("a 200 with no session cookie must fail, got state %#v", state)
	}
	if !strings.Contains(err.Error(), "CSRF") {
		t.Fatalf("the error should name the CSRF handshake so the cookie-stripping proxy gets looked at, got: %v", err)
	}
}

// A failed sign-in can arrive WITH a Set-Cookie for the session name, clearing
// a stale one. Keeping that empty cookie would make "did we get a session?"
// answer yes on a login that failed.
func TestNextAuthLoginIgnoresAClearedSessionCookie(t *testing.T) {
	srv := newNextAuthTestServer(t, nextAuthServerOptions{
		wantEmail: "ops@example.com", wantPassword: "correct-horse", clearSessionOnFailure: true,
	})

	auth := &NextAuthCredentialsAuthenticator{}
	_, err := auth.Login(context.Background(), noRedirectClient(), Target{
		BaseURL: srv.URL, Username: "ops@example.com", Password: "wrong",
	})
	if err == nil {
		t.Fatal("a cleared session cookie is not a session")
	}
}

// Cookie naming is deployment-dependent: "__Secure-" on HTTPS, plus Langfuse's
// own ".<region>" / ".<suffix>". Matching the bare name would pass on a local
// HTTP target and fail on every real deployment.
func TestNextAuthLoginRecognisesSecureAndSuffixedCookieNames(t *testing.T) {
	for _, name := range []string{
		"__Secure-next-auth.session-token",
		"next-auth.session-token.EU",
		"__Secure-next-auth.session-token.EU",
		"__Host-next-auth.session-token",
		"authjs.session-token",
	} {
		t.Run(name, func(t *testing.T) {
			srv := newNextAuthTestServer(t, nextAuthServerOptions{
				wantEmail: "ops@example.com", wantPassword: "correct-horse", sessionCookieName: name,
			})
			auth := &NextAuthCredentialsAuthenticator{}
			state, err := auth.Login(context.Background(), noRedirectClient(), Target{
				BaseURL: srv.URL, Username: "ops@example.com", Password: "correct-horse",
			})
			if err != nil {
				t.Fatalf("cookie named %q was not recognised as a session: %v", name, err)
			}
			if state.Cookies[name] == "" {
				t.Fatalf("cookie %q not carried, got %#v", name, state.Cookies)
			}
		})
	}
}

func TestNextAuthLoginHonoursABasePath(t *testing.T) {
	srv := newNextAuthTestServer(t, nextAuthServerOptions{
		wantEmail: "ops@example.com", wantPassword: "correct-horse", basePath: "/langfuse",
	})

	auth := &NextAuthCredentialsAuthenticator{}

	// Without the base path the auth API is simply not there.
	if _, err := auth.Login(context.Background(), noRedirectClient(), Target{
		BaseURL: srv.URL, Username: "ops@example.com", Password: "correct-horse",
	}); err == nil {
		t.Fatal("a sub-path deployment must not appear to log in from the bare origin")
	}

	state, err := auth.Login(context.Background(), noRedirectClient(), Target{
		BaseURL:     srv.URL,
		Username:    "ops@example.com",
		Password:    "correct-horse",
		ExtraConfig: map[string]interface{}{"web_base_path": "/langfuse"},
	})
	if err != nil {
		t.Fatalf("web_base_path should reach the sub-path auth API: %v", err)
	}
	if state.Cookies["next-auth.session-token"] == "" {
		t.Fatalf("no session captured under a base path, got %#v", state.Cookies)
	}
}

func TestNextAuthLoginBlamesConsoleURLWhenTheTargetIsNotTheApp(t *testing.T) {
	srv := newNextAuthTestServer(t, nextAuthServerOptions{
		csrfStatus: http.StatusOK, csrfContentType: "text/html", csrfBody: "<html><body>404</body></html>",
	})

	auth := &NextAuthCredentialsAuthenticator{}
	_, err := auth.Login(context.Background(), noRedirectClient(), Target{
		BaseURL: srv.URL, Username: "ops@example.com", Password: "correct-horse",
	})
	if err == nil {
		t.Fatal("an HTML page is not a CSRF endpoint")
	}
	if !strings.Contains(err.Error(), "console_url") {
		t.Fatalf("the error should send the admin to console_url rather than the vault, got: %v", err)
	}
}

// A NextAuth error that is not CredentialsSignin means the credential was
// fine and the application refused the sign-in for its own reasons. Saying
// "check the vault" there sends somebody to rotate a working password.
func TestNextAuthLoginReportsANonCredentialErrorVerbatim(t *testing.T) {
	srv := newNextAuthTestServer(t, nextAuthServerOptions{
		wantEmail: "ops@example.com", wantPassword: "correct-horse", errorOverride: "AccessDenied",
	})

	auth := &NextAuthCredentialsAuthenticator{}
	_, err := auth.Login(context.Background(), noRedirectClient(), Target{
		BaseURL: srv.URL, Username: "ops@example.com", Password: "wrong",
	})
	if err == nil {
		t.Fatal("expected the refusal to fail the login")
	}
	if !strings.Contains(err.Error(), "AccessDenied") {
		t.Fatalf("the NextAuth error should be named, got: %v", err)
	}
	if strings.Contains(err.Error(), "vault") {
		t.Fatalf("a non-credentials refusal must not blame the vault, got: %v", err)
	}
}

func TestRegistryInfersNextAuthForLangfuse(t *testing.T) {
	r := NewRegistry()

	got, err := r.Get("langfuse", nil)
	if err != nil {
		t.Fatalf("Get(langfuse): %v", err)
	}
	if got.Name() != strategyNextAuth {
		t.Fatalf("langfuse resolved to %q, want %q", got.Name(), strategyNextAuth)
	}

	// Still selectable by name for any other NextAuth application.
	got, err = r.Get("web", map[string]interface{}{"web_auth_strategy": strategyNextAuth})
	if err != nil {
		t.Fatalf("explicit strategy: %v", err)
	}
	if got.Name() != strategyNextAuth {
		t.Fatalf("explicit strategy resolved to %q", got.Name())
	}
}
