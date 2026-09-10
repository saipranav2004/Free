// pam/internal/services/network_allowlist_service.go
package services

import (
	"errors"
	"fmt"
	"net/netip"
	"sort"
	"strings"
	"sync"
	"time"

	"gorm.io/gorm"

	"github.com/yourorg/pam/internal/config"
	"github.com/yourorg/pam/internal/models"
)

// ErrWouldLockOut is returned when a change would leave the operator making
// it unable to reach the console. See NetworkAllowlistService.SetEnabled.
var ErrWouldLockOut = errors.New("network allowlist change would lock out the operator making it")

// NetworkAllowlistService owns the source-address allowlist: the stored
// ranges, the on/off switch, and the answer to "may this address in?".
//
// The answer is served from an in-memory snapshot refreshed on a short TTL
// rather than read per request. Every authenticated call to this API passes
// through the check, so a database round trip per request would put the
// allowlist on the hot path of everything; a few seconds of staleness after
// an edit is the right trade, and any write refreshes the snapshot
// immediately so the operator's own change is visible at once.
type NetworkAllowlistService struct {
	db  *gorm.DB
	ttl time.Duration

	// proxyState is what the deployment decided about the hop in front of
	// this API. The allowlist is built entirely on c.ClientIP() being the
	// operator's real address, and that is only true when this question has
	// been answered. See ProxyUnresolved for what it prevents.
	proxyState config.TrustedProxyState

	mu       sync.RWMutex
	loaded   bool
	loadedAt time.Time
	enabled  bool
	prefixes []netip.Prefix
	entries  []models.NetworkAllowlistEntry
}

func NewNetworkAllowlistService(db *gorm.DB, proxyState config.TrustedProxyState) *NetworkAllowlistService {
	return &NetworkAllowlistService{db: db, ttl: 5 * time.Second, proxyState: proxyState}
}

// ProxyState is what the deployment decided about the hop in front of the
// API, exposed so the console can warn before an operator is surprised.
func (s *NetworkAllowlistService) ProxyState() config.TrustedProxyState { return s.proxyState }

// ErrProxyUnresolved is returned when enforcement cannot be turned on
// because the API has no way to know whose address it is looking at.
//
// THE FAILURE THIS EXISTS TO PREVENT. Gin resolves the client address from
// the socket peer unless it has been told which proxies to believe. Behind a
// load balancer with that unset, EVERY request appears to come from the
// balancer. An operator then sees the balancer's address in the console,
// clicks the button that adds "their" address, and turns enforcement on. The
// switch reads Enforcing, the audit trail records the balancer for every
// session, and the control admits the entire internet: every request matches
// the one range on the list. It fails open, silently, while looking correct.
//
// Refusing here is the only place that catches it, because both halves look
// individually reasonable: the address IS what the API sees, and the list DOES
// contain it.
var ErrProxyUnresolved = errors.New("the API cannot tell whose address it is seeing")

// ── reading ─────────────────────────────────────────────────────────────

// Snapshot is what the console renders and what the nginx snippet is built
// from.
type NetworkAllowlistSnapshot struct {
	Enabled bool                           `json:"enabled"`
	Entries []models.NetworkAllowlistEntry `json:"entries"`
}

func (s *NetworkAllowlistService) Snapshot() (NetworkAllowlistSnapshot, error) {
	if err := s.refresh(true); err != nil {
		return NetworkAllowlistSnapshot{}, err
	}
	s.mu.RLock()
	defer s.mu.RUnlock()
	out := make([]models.NetworkAllowlistEntry, len(s.entries))
	copy(out, s.entries)
	return NetworkAllowlistSnapshot{Enabled: s.enabled, Entries: out}, nil
}

// IsAllowed answers whether a source address may reach the API.
//
// Deliberately allows everything when the switch is off OR the list is
// empty. An enabled-but-empty list would deny every request including the
// one that could fix it, so it is treated as "not configured yet" rather
// than "deny all" — the fail-closed reading is the one that takes the whole
// console down after a single mis-click.
//
// Loopback is always permitted: container health checks and the process's
// own calls arrive from there, and an operator who locks those out gets a
// container that reports itself unhealthy and is restarted forever.
func (s *NetworkAllowlistService) IsAllowed(ip string) (bool, error) {
	if err := s.refresh(false); err != nil {
		return false, err
	}
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.allowedLocked(ip), nil
}

func (s *NetworkAllowlistService) allowedLocked(ip string) bool {
	if !s.enabled || len(s.prefixes) == 0 {
		return true
	}
	addr, err := netip.ParseAddr(strings.TrimSpace(ip))
	if err != nil {
		// An address this process cannot parse is not something to guess
		// about. It cannot be matched against any range, so it cannot be
		// on the list.
		return false
	}
	addr = addr.Unmap()
	if addr.IsLoopback() {
		return true
	}
	for _, p := range s.prefixes {
		if p.Contains(addr) {
			return true
		}
	}
	return false
}

// ── writing ─────────────────────────────────────────────────────────────

// AddEntry stores one range. The CIDR is normalised first, so the same
// network typed two different ways cannot be added twice.
func (s *NetworkAllowlistService) AddEntry(cidr, label, userID, username string) (*models.NetworkAllowlistEntry, error) {
	normalized, err := NormalizeCIDR(cidr)
	if err != nil {
		return nil, err
	}
	label = strings.TrimSpace(label)
	if len(label) > 255 {
		label = label[:255]
	}

	var existing models.NetworkAllowlistEntry
	if err := s.db.Where("cidr = ?", normalized).First(&existing).Error; err == nil {
		return nil, fmt.Errorf("%s is already on the allowlist", normalized)
	} else if !errors.Is(err, gorm.ErrRecordNotFound) {
		return nil, err
	}

	entry := models.NewNetworkAllowlistEntry(normalized, label, userID, username)
	if err := s.db.Create(&entry).Error; err != nil {
		return nil, err
	}
	s.invalidate()
	return &entry, nil
}

// RemoveEntry deletes one range.
//
// Removing the range the caller is sitting in, while enforcement is on,
// would take effect immediately and lock them out — so that specific case is
// refused rather than performed. Removing any other range is fine, and so is
// removing this one once enforcement is off.
func (s *NetworkAllowlistService) RemoveEntry(id, callerIP string) error {
	var entry models.NetworkAllowlistEntry
	if err := s.db.Where("id = ?", id).First(&entry).Error; err != nil {
		return err
	}

	snapshot, err := s.Snapshot()
	if err != nil {
		return err
	}
	if snapshot.Enabled {
		remaining := make([]string, 0, len(snapshot.Entries))
		for _, e := range snapshot.Entries {
			if e.ID != id {
				remaining = append(remaining, e.CIDR)
			}
		}
		if len(remaining) > 0 && !cidrsContain(remaining, callerIP) {
			return fmt.Errorf("%w: removing %s would leave your own address (%s) outside the allowlist",
				ErrWouldLockOut, entry.CIDR, callerIP)
		}
	}

	if err := s.db.Delete(&models.NetworkAllowlistEntry{}, "id = ?", id).Error; err != nil {
		return err
	}
	s.invalidate()
	return nil
}

// SetEnabled turns enforcement on or off.
//
// Turning it ON is refused unless the caller's own address is already
// covered by the list. This is the single most important rule here: the
// control being configured is the one that decides whether the operator can
// reach the console at all, so the obvious mistake — save the switch, forget
// to add your own office range — is the one that costs a redeploy or a
// database edit to undo. Every product that ships this control does the same
// check, and it is cheap: the address is right there on the request.
//
// Turning it OFF is never refused. Recovery must not itself be gated.
func (s *NetworkAllowlistService) SetEnabled(enabled bool, callerIP, userID, username string) error {
	if enabled {
		snapshot, err := s.Snapshot()
		if err != nil {
			return err
		}
		cidrs := make([]string, 0, len(snapshot.Entries))
		for _, e := range snapshot.Entries {
			cidrs = append(cidrs, e.CIDR)
		}
		if len(cidrs) == 0 {
			return fmt.Errorf("%w: add at least one range before turning enforcement on", ErrWouldLockOut)
		}
		if err := s.checkProxyResolved(callerIP); err != nil {
			return err
		}
		if !isLoopback(callerIP) && !cidrsContain(cidrs, callerIP) {
			return fmt.Errorf("%w: your own address (%s) is not covered by any entry. Add it first.",
				ErrWouldLockOut, callerIP)
		}
	}

	settings := models.NetworkAllowlistSettings{
		ID:                models.NetworkAllowlistSettingsID,
		Enabled:           enabled,
		UpdatedByUserID:   userID,
		UpdatedByUsername: username,
	}
	if err := s.db.Save(&settings).Error; err != nil {
		return err
	}
	s.invalidate()
	return nil
}

// ── nginx ───────────────────────────────────────────────────────────────

// NginxSnippet renders the stored list as nginx directives, so the edge can
// enforce the same decision the API does without either side keeping its own
// copy of the ranges.
//
// Emits nothing but allow/deny lines, which is what makes it safe to include
// from inside a server block. When enforcement is off, or nothing has been
// added yet, the result is a comment and no directives at all: an include
// that suddenly contained "deny all" the moment someone toggled a switch
// would take the console offline for everybody.
func (s *NetworkAllowlistService) NginxSnippet() (string, error) {
	snapshot, err := s.Snapshot()
	if err != nil {
		return "", err
	}

	var b strings.Builder
	b.WriteString("# Generated by pam-api from the network allowlist.\n")
	b.WriteString("# Managed in the console under Settings > Organization.\n")
	b.WriteString("# Do not edit by hand: this file is replaced on every refresh.\n")

	// Say which address the API believes it is comparing against, because
	// nginx is comparing against a DIFFERENT one and the two are configured
	// separately: the API has PAM_NETWORK_TRUSTED_PROXIES, nginx has
	// set_real_ip_from in its own conf. Get one right and the other wrong and
	// the same list produces opposite outcomes on the two layers, with the
	// only symptom a 403 from nginx on a console the API is happy to serve.
	//
	// The entrypoint script echoes this file's header on a failed reload, so
	// this line is what turns that split brain into something a person can
	// read in the container log instead of a bare 403.
	switch s.proxyState {
	case config.TrustedProxyConfigured:
		b.WriteString("# API real-ip: trusted proxy ranges are configured, so it compares the forwarded client address.\n")
		b.WriteString("# nginx must match: set_real_ip_from for the same hops, or these allow lines will be compared\n")
		b.WriteString("# against the proxy's address instead of the operator's.\n")
	case config.TrustedProxyDirect:
		b.WriteString("# API real-ip: declared direct (trusted_proxies=none), so it compares the socket peer.\n")
		b.WriteString("# nginx must match: do NOT set real_ip_header here, or a client could name its own address.\n")
	default:
		b.WriteString("# API real-ip: UNDECIDED. PAM_NETWORK_TRUSTED_PROXIES is not set, so the API compares the\n")
		b.WriteString("# socket peer, which behind a load balancer is the balancer and not the operator.\n")
		b.WriteString("# Enforcement cannot be switched on from the console in this state; set that variable to\n")
		b.WriteString("# the proxy ranges, or to \"none\" if this API is reached directly.\n")
	}

	if !snapshot.Enabled || len(snapshot.Entries) == 0 {
		b.WriteString("# Enforcement is off, or no ranges are configured. No restriction applied.\n")
		return b.String(), nil
	}

	b.WriteString("allow 127.0.0.1;\t# container health check\n")
	b.WriteString("allow ::1;\n")
	for _, e := range snapshot.Entries {
		if label := sanitizeNginxComment(e.Label); label != "" {
			fmt.Fprintf(&b, "allow %s;\t# %s\n", e.CIDR, label)
			continue
		}
		fmt.Fprintf(&b, "allow %s;\n", e.CIDR)
	}
	b.WriteString("deny all;\n")
	return b.String(), nil
}

// sanitizeNginxComment reduces a label to characters that cannot mean
// anything to nginx.
//
// The label is free text an operator types, and it ends up in a file nginx
// parses. Stripping the obvious terminators is not enough: dropping ';' from
// "allow 0.0.0.0/0;" still leaves text that reads like a directive to the
// next person debugging the file. So this whitelists instead of blacklists —
// letters, digits, space and a few separators — which cannot form a
// directive whatever is typed, and collapses the result to a single line.
func sanitizeNginxComment(label string) string {
	var b strings.Builder
	for _, r := range label {
		switch {
		case r >= 'a' && r <= 'z', r >= 'A' && r <= 'Z', r >= '0' && r <= '9':
			b.WriteRune(r)
		case r == ' ', r == '-', r == '_', r == '.', r == ',', r == '(', r == ')':
			b.WriteRune(r)
		default:
			b.WriteRune(' ')
		}
	}
	label = strings.Join(strings.Fields(b.String()), " ")
	if len(label) > 60 {
		label = strings.TrimSpace(label[:60])
	}
	return label
}

// ── helpers ─────────────────────────────────────────────────────────────

// NormalizeCIDR accepts either a bare address or a CIDR and returns the
// canonical network form.
//
// A bare address becomes a single-host range (/32 or /128), which is what an
// operator typing their office IP means. A CIDR whose host bits are set —
// 183.82.2.29/24, the shape people actually paste — is masked down to
// 183.82.2.0/24 rather than rejected, because rejecting it teaches nothing
// and masking it is unambiguous.
func NormalizeCIDR(input string) (string, error) {
	raw := strings.TrimSpace(input)
	if raw == "" {
		return "", errors.New("enter an IP address or CIDR range")
	}
	if strings.Contains(raw, "/") {
		prefix, err := netip.ParsePrefix(raw)
		if err != nil {
			return "", fmt.Errorf("%q is not a valid CIDR range", raw)
		}
		return prefix.Masked().String(), nil
	}
	addr, err := netip.ParseAddr(raw)
	if err != nil {
		return "", fmt.Errorf("%q is not a valid IP address", raw)
	}
	addr = addr.Unmap()
	return netip.PrefixFrom(addr, addr.BitLen()).String(), nil
}

func cidrsContain(cidrs []string, ip string) bool {
	addr, err := netip.ParseAddr(strings.TrimSpace(ip))
	if err != nil {
		return false
	}
	addr = addr.Unmap()
	for _, c := range cidrs {
		p, err := netip.ParsePrefix(c)
		if err != nil {
			continue
		}
		if p.Contains(addr) {
			return true
		}
	}
	return false
}

func isLoopback(ip string) bool {
	addr, err := netip.ParseAddr(strings.TrimSpace(ip))
	if err != nil {
		return false
	}
	return addr.Unmap().IsLoopback()
}

// checkProxyResolved refuses to enable enforcement when the address the API
// sees cannot be trusted to be the operator's. See ErrProxyUnresolved.
//
// Only the UNDECIDED state is refused, and only for an address that looks
// like infrastructure. The three states are deliberately not treated alike:
//
//	configured  ranges were given, so X-Forwarded-For is resolved and the
//	            address IS the operator. Allowed.
//	direct      the operator asserted "none": nothing sits in front, so the
//	            socket peer IS the operator, even on a private range. This is
//	            the ordinary VPN or private-network deployment, and refusing
//	            it would be a false alarm on a correct configuration.
//	undecided   nobody has answered the question. On a laptop that is
//	            harmless; behind a load balancer it is the silent fail-open.
//
// So the way out is never "turn the guard off", it is to answer the question:
// set the proxy ranges, or set "none" to state that there are none. Either
// answer is one environment variable and both are checked by test.
func (s *NetworkAllowlistService) checkProxyResolved(callerIP string) error {
	if s.proxyState != config.TrustedProxyUndecided {
		return nil
	}
	// A loopback caller is somebody on the machine itself; there is no proxy
	// hop to misread, and the lockout guard below already handles it.
	if isLoopback(callerIP) {
		return nil
	}
	if !isInfrastructureAddress(callerIP) {
		// A public address reached this process directly. Nothing was
		// forwarded, so nothing was misread.
		return nil
	}
	return fmt.Errorf("%w: it sees you at %s, which is a private range, and no trusted proxy set is configured. "+
		"Behind a load balancer that address is the balancer, not you, and enabling now would admit every network that can reach it. "+
		"Set PAM_NETWORK_TRUSTED_PROXIES to the ranges of whatever sits in front of this API, "+
		"or to the literal \"none\" if this API is reached directly, then try again",
		ErrProxyUnresolved, callerIP)
}

// isInfrastructureAddress reports whether an address is one that a machine
// between the operator and this API would plausibly have: RFC1918 private
// space, RFC6598 carrier-grade NAT, and link-local.
//
// Loopback is deliberately NOT included: the caller checks it first and means
// something different by it (somebody on this host), and unique-local IPv6
// (fc00::/7) is included through IsPrivate.
// IsInfrastructureAddress is exported for the handler, which tells the
// console whether the address the API sees looks like a hop rather than a
// person. See checkProxyResolved for why that matters.
func IsInfrastructureAddress(ip string) bool { return isInfrastructureAddress(ip) }

func isInfrastructureAddress(ip string) bool {
	addr, err := netip.ParseAddr(strings.TrimSpace(ip))
	if err != nil {
		// Unparseable is not evidence of a proxy, and the middleware already
		// denies an address it cannot parse.
		return false
	}
	addr = addr.Unmap()
	if addr.IsPrivate() || addr.IsLinkLocalUnicast() {
		return true
	}
	// RFC6598 100.64.0.0/10, which Go does not class as private. It is what
	// several cloud load balancers and NAT gateways actually use.
	cgnat := netip.MustParsePrefix("100.64.0.0/10")
	return addr.Is4() && cgnat.Contains(addr)
}

// ── snapshot cache ──────────────────────────────────────────────────────

func (s *NetworkAllowlistService) invalidate() {
	s.mu.Lock()
	s.loaded = false
	s.mu.Unlock()
}

func (s *NetworkAllowlistService) refresh(force bool) error {
	s.mu.RLock()
	fresh := s.loaded && time.Since(s.loadedAt) < s.ttl
	s.mu.RUnlock()
	if fresh && !force {
		return nil
	}

	var settings models.NetworkAllowlistSettings
	err := s.db.Where("id = ?", models.NetworkAllowlistSettingsID).First(&settings).Error
	if err != nil && !errors.Is(err, gorm.ErrRecordNotFound) {
		return err
	}

	var entries []models.NetworkAllowlistEntry
	if err := s.db.Order("cidr asc").Find(&entries).Error; err != nil {
		return err
	}
	sort.SliceStable(entries, func(i, j int) bool { return entries[i].CIDR < entries[j].CIDR })

	prefixes := make([]netip.Prefix, 0, len(entries))
	for _, e := range entries {
		if p, err := netip.ParsePrefix(e.CIDR); err == nil {
			prefixes = append(prefixes, p)
		}
	}

	s.mu.Lock()
	s.enabled = settings.Enabled
	s.entries = entries
	s.prefixes = prefixes
	s.loaded = true
	s.loadedAt = time.Now()
	s.mu.Unlock()
	return nil
}
