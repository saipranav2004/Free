// localStorage can throw (private mode, blocked storage) — never let that break ordering.
export function readJson<T>(key: string, fallback: T): T {
  try {
    const raw = window.localStorage.getItem(key)
    return raw ? (JSON.parse(raw) as T) : fallback
  } catch {
    return fallback
  }
}

export function writeJson(key: string, value: unknown) {
  try {
    window.localStorage.setItem(key, JSON.stringify(value))
  } catch {
    /* storage unavailable: keep working in memory */
  }
}

export function removeKey(key: string) {
  try {
    window.localStorage.removeItem(key)
  } catch {
    /* ignore */
  }
}
