// ---------------------------------------------------------------------------
// Developer Tools guard
// ---------------------------------------------------------------------------
// THIS IS A DETERRENT, NOT A SECURITY BOUNDARY. Read this before changing it,
// and before describing the feature to anyone.
//
// DevTools is the debugger and this page is the debuggee. A debuggee cannot
// revoke its debugger. Everything below is JavaScript running inside the page,
// and DevTools can switch JavaScript off (Settings, Preferences, Disable
// JavaScript, or the Emulation.setScriptExecutionDisabled protocol command),
// which makes every line here inert. It can also be opened before this page
// loads, so the guard never runs at all.
//
// It also does not empty the Network panel, and nothing in a page can. That
// panel records at the browser's network stack, below and outside this script's
// execution context: requests are captured as they leave, before any page code
// could react, and no API exists to read, clear or suppress those entries.
//
// So what this file honestly buys:
//
//   FRICTION      an operator who reaches for F12 or the three-dots menu finds
//                 the console stops being useful.
//   ATTRIBUTION   the attempt is reported, when a report endpoint is
//                 configured, so it lands next to the operator and the session
//                 where an investigator can act on it.
//
// What it does not buy, and must never be described as buying: prevention.
// Removing the DevTools menu entry itself is endpoint policy (Chrome and Edge
// DeveloperToolsAvailability), not application code.
//
// ---------------------------------------------------------------------------
// Three detection signals, and what each is actually good for
// ---------------------------------------------------------------------------
//
//   docked    outerWidth/Height minus innerWidth/Height grows when DevTools
//             docks into the window. Catches the common case (F12, or the
//             three-dots menu with the default docked layout). Blind to an
//             undocked panel, which changes nothing about the window.
//
//             Measured as a DELTA AGAINST A BASELINE taken at install, not
//             against a raw threshold. A raw threshold false-positives on every
//             browser showing a bookmarks bar, a downloads shelf or an
//             extension banner, because those already eat 100 to 200px before
//             DevTools is anywhere near the picture.
//
//             Page zoom also moves innerWidth (it is measured in CSS pixels),
//             which looks identical to a docked panel. Chrome changes
//             devicePixelRatio when the page zooms, so a DPR change re-takes
//             the baseline instead of tripping the guard.
//
//   debugger  a `debugger` statement costs nothing when DevTools is closed and
//             suspends the page when it is open, so wall time across it
//             separates the two. Catches the undocked panel that `docked`
//             misses. Built with new Function so no literal debugger statement
//             ships in app source (eslint no-debugger, and a minifier is free
//             to move a real one), and so a Content-Security-Policy without
//             'unsafe-eval' degrades to the other two signals instead of
//             throwing on every tick.
//
//   console   an object whose getter fires only when the Console panel renders
//             it. The weakest of the three by a wide margin: it reports nothing
//             while the operator sits on the Network tab, which is the exact
//             tab that prompted this work. Kept because it costs one line and
//             occasionally catches what the other two miss.
//
// TWO RULES THAT KEEP THIS FROM BECOMING AN OUTAGE:
//
//   1. A signal must hold for `confirmTicks` consecutive checks before the page
//      is blocked. One transient reading during a window drag or a monitor
//      change must never wipe a working session.
//   2. Recovery re-runs EVERY enabled signal, not just the one that tripped.
//      Recovering on a subset is how you build a reload loop: trip on
//      `console`, wipe, see `docked` clear, reload, trip again, forever.
// ---------------------------------------------------------------------------

const OVERLAY_ID = '__pam_devtools_block'

// The keystrokes worth intercepting. Note what this can and cannot do: a page
// can cancel these as DOM events on some browsers, but Chrome and Edge consume
// F12 and Ctrl+Shift+I in the browser process before the page ever sees a
// keydown, and no page can touch the three-dots menu at all. Blocking them is
// worth doing because it removes the reflex, not because it closes the door.
function blockedShortcut(e) {
  const key = String(e.key || '').toLowerCase()
  if (key === 'f12' || e.keyCode === 123) return 'key:f12'

  if (!(e.ctrlKey || e.metaKey)) return null
  if (e.shiftKey && (key === 'i' || key === 'j' || key === 'c' || key === 'k')) {
    return `key:mod-shift-${key}`
  }
  if (!e.shiftKey && (key === 'u' || key === 's' || key === 'p')) {
    return `key:mod-${key}`
  }
  return null
}

const SELECTION_CSS =
  '*{-webkit-user-select:none!important;user-select:none!important;}' +
  'input,textarea,[contenteditable]{-webkit-user-select:text!important;user-select:text!important;}'

function isEditable(node) {
  if (!node) return false
  const tag = node.tagName ? String(node.tagName).toLowerCase() : ''
  return tag === 'input' || tag === 'textarea' || node.isContentEditable === true
}

export const DEVTOOLS_GUARD_DEFAULTS = {
  enabled: false,
  // Evaluated on every check and every intercepted event, so the guard is
  // dormant until there is a protected session to protect.
  isProtected: () => true,
  // (signal) => Promise<boolean> | boolean. Resolving true is what earns the
  // overlay the right to say the event was recorded. With no reporter the
  // overlay says the session is monitored instead, which is the honest line
  // when there is nothing on the other end.
  report: null,
  // Called once, BEFORE the DOM is wiped, so the host app can shut itself down
  // cleanly rather than being torn out from under a running render.
  onDetect: null,
  blockShortcuts: true,
  blockClipboard: true,
  blockSelection: true,
  useDockedProbe: true,
  useDebuggerProbe: true,
  useConsoleProbe: true,
  dockedDeltaPx: 160,
  debuggerPauseMs: 100,
  checkIntervalMs: 1000,
  recoveryIntervalMs: 2000,
  // Consecutive positive checks required before blocking. See rule 1 above.
  confirmTicks: 2,
  // Minimum time the block stays up before a recovery reload is allowed. Stops
  // a borderline reading flapping the page between blocked and reloaded.
  minBlockMs: 1500,
  // How often the console probe runs, in ticks. It is the only probe that
  // writes to the console, so a deployment that finds the noise costly can dial
  // it back without losing the other two.
  consoleProbeEveryTicks: 1,
}

let installed = false

/**
 * Installs the guard. Call once, at boot, before anything renders.
 *
 * Returns an uninstall function. Uninstall is idempotent, and a second install
 * while one is live is a no-op that returns a no-op.
 */
export function installDevtoolsGuard(options = {}) {
  const cfg = { ...DEVTOOLS_GUARD_DEFAULTS, ...options }
  const noop = () => {}

  if (!cfg.enabled) return noop
  if (typeof window === 'undefined' || typeof document === 'undefined') return noop
  if (installed) return noop
  installed = true

  const listeners = []
  let styleEl = null
  let checkTimer = null
  let recoveryTimer = null
  let tripped = false
  let trippedAt = 0
  let streak = 0
  let ticks = 0

  const on = (target, type, handler, capture) => {
    target.addEventListener(type, handler, capture)
    listeners.push([target, type, handler, capture])
  }

  const active = () => {
    try {
      return cfg.isProtected() === true
    } catch {
      return false
    }
  }

  const swallow = (e) => {
    try {
      e.preventDefault()
      e.stopPropagation()
    } catch {
      // A page that has already stopped propagation is not a reason to throw.
    }
  }

  // ── friction: shortcuts, clipboard, selection ──────────────────────────

  if (cfg.blockShortcuts) {
    on(
      document,
      'keydown',
      (e) => {
        if (!active() || !blockedShortcut(e)) return
        swallow(e)
        // A shortcut press is intent, not a detection: the browser may have
        // opened DevTools anyway. The probes decide that, on the next tick.
        check()
      },
      true
    )
  }

  if (cfg.blockClipboard) {
    for (const type of ['copy', 'cut', 'dragstart', 'contextmenu']) {
      on(
        document,
        type,
        (e) => {
          if (active()) swallow(e)
        },
        true
      )
    }
  }

  if (cfg.blockSelection) {
    on(
      document,
      'selectstart',
      (e) => {
        // Never fight a real text field. Blocking selection inside an input is
        // how a guard turns into a bug report.
        if (active() && !isEditable(e.target)) swallow(e)
      },
      true
    )
  }

  // The selection stylesheet follows isProtected the same way every listener
  // does, attached while a protected session is live and detached otherwise.
  // Attaching it once at install looked equivalent and was not: it left
  // user-select:none on the sign-in and MFA screens, where there is no session
  // to protect and where a user may well need to select the text of an error
  // in order to report it.
  function syncSelectionStyle() {
    if (!cfg.blockSelection) return
    const want = active()
    if (want && !styleEl) {
      try {
        styleEl = document.createElement('style')
        styleEl.setAttribute('data-pam-guard', 'selection')
        styleEl.appendChild(document.createTextNode(SELECTION_CSS))
        ;(document.head || document.documentElement).appendChild(styleEl)
      } catch {
        styleEl = null
      }
      return
    }
    if (!want && styleEl) {
      try {
        if (styleEl.parentNode) styleEl.parentNode.removeChild(styleEl)
      } catch {
        // Already gone with the rest of the document; nothing to undo.
      }
      styleEl = null
    }
  }

  // ── signal 1: docked panel ─────────────────────────────────────────────

  let baseW = window.outerWidth - window.innerWidth
  let baseH = window.outerHeight - window.innerHeight
  let baseDpr = window.devicePixelRatio

  function rebaseline() {
    baseW = window.outerWidth - window.innerWidth
    baseH = window.outerHeight - window.innerHeight
    baseDpr = window.devicePixelRatio
  }

  function dockedOpen() {
    if (!cfg.useDockedProbe) return false
    // Zoom moves innerWidth without DevTools being involved, and Chrome reports
    // it as a devicePixelRatio change. Treat the old baseline as void rather
    // than reading a zoom as a panel.
    if (window.devicePixelRatio !== baseDpr) {
      rebaseline()
      return false
    }
    const dw = window.outerWidth - window.innerWidth - baseW
    const dh = window.outerHeight - window.innerHeight - baseH
    return dw > cfg.dockedDeltaPx || dh > cfg.dockedDeltaPx
  }

  // ── signal 2: debugger timing ──────────────────────────────────────────

  let pauseProbe = null
  if (cfg.useDebuggerProbe) {
    try {
      pauseProbe = new Function('debugger')
    } catch {
      // CSP without 'unsafe-eval'. Fail once, here, and carry on with two
      // signals rather than throwing on every tick forever.
      pauseProbe = null
    }
  }

  function debuggerPaused() {
    if (!pauseProbe) return false
    try {
      const t0 = performance.now()
      pauseProbe()
      return performance.now() - t0 > cfg.debuggerPauseMs
    } catch {
      return false
    }
  }

  // ── signal 3: console getter ───────────────────────────────────────────

  function consoleOpen() {
    if (!cfg.useConsoleProbe) return false
    // Nothing to render into in a hidden tab, and no reason to accumulate
    // console entries in one either.
    if (document.visibilityState === 'hidden') return false
    if (cfg.consoleProbeEveryTicks > 1 && ticks % cfg.consoleProbeEveryTicks !== 0) return false
    try {
      let hit = false
      const probe = {}
      // A fresh probe every call. A shared one latches on first fire and then
      // reports "open" forever, pinning the page in the blocked state long
      // after DevTools was closed.
      Object.defineProperty(probe, 'id', {
        configurable: true,
        get() {
          hit = true
          return ''
        },
      })
      console.log(probe)
      return hit
    } catch {
      return false
    }
  }

  function detect() {
    if (dockedOpen()) return 'docked'
    if (debuggerPaused()) return 'debugger'
    if (consoleOpen()) return 'console'
    return null
  }

  // ── the block ──────────────────────────────────────────────────────────

  function paint(recorded) {
    const host = document.body || document.documentElement
    if (!host) return

    let box = document.getElementById(OVERLAY_ID)
    if (!box) {
      box = document.createElement('div')
      box.id = OVERLAY_ID
      host.appendChild(box)
    }
    box.setAttribute('role', 'alertdialog')
    box.setAttribute('aria-live', 'assertive')
    // Inline styles throughout: the app's stylesheet went with the rest of the
    // document, so nothing here may depend on it.
    box.style.cssText = [
      'position:fixed',
      'inset:0',
      'z-index:2147483647',
      'display:flex',
      'align-items:center',
      'justify-content:center',
      'padding:24px',
      'background:#0a0c10',
      'color:#e6e9ef',
      'font:400 15px/1.55 ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif',
      '-webkit-user-select:none',
      'user-select:none',
    ].join(';')

    const card = document.createElement('div')
    card.style.cssText = [
      'max-width:460px',
      'width:100%',
      'text-align:center',
      'border:1px solid #232833',
      'border-radius:12px',
      'background:#11141b',
      'padding:32px 28px',
      'box-shadow:0 18px 48px rgba(0,0,0,0.55)',
    ].join(';')

    const parts = [
      ['Developer Tools detected', 'font-size:19px;font-weight:600;color:#f4f6fa;margin-bottom:10px'],
      ['Close Developer Tools to continue.', 'color:#aab2c0;margin-bottom:6px'],
      [recorded ? 'This event has been recorded.' : 'This session is monitored.', 'color:#aab2c0'],
      [
        'This page reloads by itself once Developer Tools is closed.',
        'margin-top:18px;font-size:13px;color:#6f7887',
      ],
    ]
    for (const [text, css] of parts) {
      const el = document.createElement('div')
      el.textContent = text
      el.style.cssText = css
      card.appendChild(el)
    }

    box.textContent = ''
    box.appendChild(card)
  }

  function trip(signal) {
    if (tripped) return
    tripped = true
    trippedAt = Date.now()

    // Before the DOM goes, so the host app can unmount and cancel its own
    // in-flight work instead of rendering into a mount point that is about to
    // disappear.
    try {
      if (typeof cfg.onDetect === 'function') cfg.onDetect(signal)
    } catch {
      // A failing host callback must never stop the block being drawn.
    }

    try {
      window.stop()
    } catch {
      // Not implemented everywhere; the wipe below is what matters.
    }

    // The wipe. Worth being precise about what this achieves: it empties the
    // Elements panel of application markup and stops the app rendering anything
    // further. It does NOT erase the Network panel, which recorded every
    // request at the network stack before this code ran.
    try {
      document.documentElement.innerHTML = '<head></head><body></body>'
      document.title = 'Developer Tools detected'
    } catch {
      // Fall through: paint() renders onto whatever is left.
    }
    styleEl = null

    paint(false)

    if (typeof cfg.report === 'function') {
      try {
        Promise.resolve(cfg.report(signal))
          .then((ok) => {
            // Only repaint if the block is still up, and only ever to upgrade
            // the wording once the report is known to have landed.
            if (tripped && ok === true) paint(true)
          })
          .catch(() => {})
      } catch {
        // Reporting is best effort. It never blocks the block.
      }
    }

    if (checkTimer) {
      clearInterval(checkTimer)
      checkTimer = null
    }
    recoveryTimer = setInterval(recover, cfg.recoveryIntervalMs)
  }

  function recover() {
    if (!tripped) return
    if (Date.now() - trippedAt < cfg.minBlockMs) return
    ticks += 1
    // Every signal, not just the one that tripped. See rule 2 in the header.
    if (detect()) return
    try {
      window.location.reload()
    } catch {
      // If reload is unavailable the block stays up, which is the safe
      // direction to fail in.
    }
  }

  function check() {
    if (tripped) return
    syncSelectionStyle()
    if (!active()) {
      streak = 0
      return
    }
    ticks += 1
    const signal = detect()
    if (!signal) {
      streak = 0
      return
    }
    streak += 1
    if (streak >= cfg.confirmTicks) trip(signal)
  }

  on(window, 'resize', check, false)
  checkTimer = setInterval(check, cfg.checkIntervalMs)
  check()

  return function uninstall() {
    if (!installed) return
    installed = false

    if (checkTimer) clearInterval(checkTimer)
    if (recoveryTimer) clearInterval(recoveryTimer)
    checkTimer = null
    recoveryTimer = null

    for (const [target, type, handler, capture] of listeners) {
      target.removeEventListener(type, handler, capture)
    }
    listeners.length = 0

    if (styleEl && styleEl.parentNode) styleEl.parentNode.removeChild(styleEl)
    styleEl = null

    const box = document.getElementById(OVERLAY_ID)
    if (box && box.parentNode) box.parentNode.removeChild(box)

    tripped = false
    streak = 0
    ticks = 0
  }
}
