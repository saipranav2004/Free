#!/bin/sh
# Pull the network allowlist from the API and keep it current.
#
# The ranges live in the database, managed by the root operator in the
# console under Settings > Organization. nginx cannot read a database, so
# this renders them into a file nginx includes, then re-fetches on an
# interval and reloads only when the content has actually changed.
#
# Runs from /docker-entrypoint.d, which the official nginx image executes
# before starting the server.
#
# Configuration, all optional:
#   PAM_API_BASE_URL       where the API is, e.g. https://api.internal
#   PAM_ALLOWLIST_TOKEN    matches the API's PAM_NETWORK_SNIPPET_TOKEN
#   PAM_ALLOWLIST_INTERVAL seconds between refreshes (default 60)
#
# Missing configuration is NOT an error. The console still serves, because
# the API enforces the same list itself and is the layer that actually
# protects data — this copy only keeps the static bundle away from networks
# that were never permitted.
set -eu

DIR=/etc/nginx/allowlist
FILE="$DIR/allowlist.conf"
INTERVAL="${PAM_ALLOWLIST_INTERVAL:-60}"

mkdir -p "$DIR"

# An empty file, not a missing one. The include below it uses a wildcard, so
# a missing file is fine too, but writing one makes "fetched nothing" and
# "never ran" distinguishable when someone looks.
[ -f "$FILE" ] || printf '# Not fetched yet. No restriction applied.\n' > "$FILE"

if [ -z "${PAM_API_BASE_URL:-}" ] || [ -z "${PAM_ALLOWLIST_TOKEN:-}" ]; then
  echo "network-allowlist: PAM_API_BASE_URL or PAM_ALLOWLIST_TOKEN unset, serving without an edge allowlist" >&2
  exit 0
fi

URL="${PAM_API_BASE_URL%/}/api/v1/pam/network/allowlist.conf"

fetch() {
  # -O- to stdout so a failed fetch cannot truncate the live file: the
  # caller only replaces it once a complete body has been read.
  wget -q -T 10 -O- --header "Authorization: Bearer ${PAM_ALLOWLIST_TOKEN}" "$URL" 2>/dev/null
}

install_if_changed() {
  new="$1"
  # Refuse to install an empty body. A 404, a proxy error page stripped to
  # nothing, or a truncated read would otherwise replace real directives
  # with nothing at all and quietly drop the restriction.
  [ -n "$new" ] || return 1
  printf '%s\n' "$new" > "$FILE.tmp"
  if cmp -s "$FILE.tmp" "$FILE"; then
    rm -f "$FILE.tmp"
    return 1
  fi
  # Never install something nginx will not load. A config error here would
  # otherwise take the console down on the next reload.
  cp "$FILE" "$FILE.prev" 2>/dev/null || true
  mv "$FILE.tmp" "$FILE"
  if ! nginx -t >/dev/null 2>&1; then
    echo "network-allowlist: fetched directives failed nginx -t, keeping the previous file" >&2
    [ -f "$FILE.prev" ] && mv "$FILE.prev" "$FILE"
    return 1
  fi
  rm -f "$FILE.prev"
  return 0
}

# First fetch happens before nginx starts, so the very first request is
# already covered rather than open for one interval.
if body="$(fetch)"; then
  install_if_changed "$body" || true
else
  echo "network-allowlist: initial fetch failed, serving without an edge allowlist" >&2
fi

# Then keep it current in the background. Reload rather than restart: an
# operator adding a range should not drop the connections of everyone
# already working.
(
  while sleep "$INTERVAL"; do
    if body="$(fetch)"; then
      if install_if_changed "$body"; then
        nginx -s reload 2>/dev/null || true
        echo "network-allowlist: updated and reloaded" >&2
      fi
    fi
  done
) &
