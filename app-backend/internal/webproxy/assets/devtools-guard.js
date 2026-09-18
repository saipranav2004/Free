/*
 * pam/internal/webproxy/assets/devtools-guard.js
 *
 * The DevTools deterrent for BROKERED pages: MinIO Console, RedisInsight,
 * Metabase, and every other third-party web application PAM reverse-proxies.
 *
 * ── What this is, stated once, plainly ────────────────────────────────────
 *
 * THIS IS A DETERRENT, NOT A SECURITY BOUNDARY. It belongs to the second group
 * in dlp.go's header: friction and attribution, defeatable by design. DevTools
 * is the debugger and this page is the debuggee, and a debuggee cannot revoke
 * its debugger. It can switch JavaScript off, or open before this page loads,
 * and every line here becomes inert. It also cannot empty the Network panel:
 * that records at the browser's network stack, below and outside this script.
 *
 * What actually protects a brokered session is server-side and already in the
 * data path: proxy.go captures the target's Set-Cookie into the server-side
 * jar and strips it from the response, so an operator with DevTools wide open
 * finds PAM's own opaque proxy cookie and nothing usable against the target.
 *
 * ── How enterprise products do this, and what was taken ───────────────────
 *
 * The pattern across CyberArk, BeyondTrust and Citrix-style brokered access is
 * consistent, and this file follows it:
 *
 *   1. The unbypassable controls live in the broker, never in the page. Ours
 *      are cookie stripping, download refusal and the egress budget.
 *   2. The page-level layer is friction plus a visible watermark, so a
 *      screenshot or a photograph is attributable to one operator and session.
 *   3. Every defeat attempt is REPORTED rather than silently blocked, because
 *      the report is evidence of intent and the block never was proof of
 *      prevention.
 *   4. The block is recoverable, not terminal. Products that kill the session
 *      on a heuristic generate support tickets from false positives; products
 *      that pause and recover do not.
 *
 * The one thing deliberately NOT taken from that survey is obfuscation. Minified
 * and packed guards are common and buy nothing: the operator does not need to
 * read the guard to disable JavaScript.
 *
 * ── Counterpart ───────────────────────────────────────────────────────────
 *
 * new_frontend/src/lib/devtoolsGuard.js does the same job for the PAM console
 * itself. Same three signals, same thresholds, same recovery rule. This one is
 * a plain ES5 IIFE with no build step, because it is injected into an arbitrary
 * third-party page that PAM does not control.
 *
 * Configuration arrives as window.__PAM_DEVTOOLS_GUARD, written by the server
 * immediately before this script.
 */
(function () {
  'use strict'
  try {
    if (window.__pamDevtoolsGuardInstalled) return
    window.__pamDevtoolsGuardInstalled = true

    var CFG = window.__PAM_DEVTOOLS_GUARD || {}
    var REPORT = CFG.report || ''
    var DOCKED_PX = CFG.dockedDeltaPx || 160
    var PAUSE_MS = CFG.debuggerPauseMs || 100
    var CHECK_MS = CFG.checkIntervalMs || 1000
    var RECOVER_MS = CFG.recoveryIntervalMs || 2000
    var CONFIRM_TICKS = CFG.confirmTicks || 2
    var MIN_BLOCK_MS = 1500
    var OVERLAY_ID = '__pam_devtools_block'

    var tripped = false
    var trippedAt = 0
    var streak = 0
    var checkTimer = null
    var recoveryTimer = null

    function swallow(e) {
      try {
        e.preventDefault()
        e.stopPropagation()
      } catch (x) {
        /* a page that already stopped propagation is not a reason to throw */
      }
    }

    function report(kind) {
      if (!REPORT) return
      try {
        var body = JSON.stringify({ kind: kind })
        if (navigator.sendBeacon) {
          navigator.sendBeacon(REPORT, new Blob([body], { type: 'application/json' }))
        }
      } catch (x) {
        /* best effort, always */
      }
    }

    /* ---- friction: pointer, selection, clipboard ----------------------
     * contextmenu removes the right-click route to Inspect. The clipboard
     * events are the same set dlp.go's clipboard guard suppresses, repeated
     * here so the deterrent is complete even on a session whose policy did not
     * ask for clipboard blocking. Both guards cancelling the same event is
     * harmless: preventDefault twice is preventDefault once.
     *
     * PASTE is included because a brokered session is not only about data
     * leaving. Pasting a command into a proxied admin console is an INBOUND
     * action, and on a recorded session it is the one action the recording
     * cannot reconstruct from keystrokes.
     */
    var POINTER_EVENTS = ['contextmenu', 'copy', 'cut', 'paste', 'dragstart']
    for (var i = 0; i < POINTER_EVENTS.length; i++) {
      ;(function (name) {
        document.addEventListener(
          name,
          function (e) {
            swallow(e)
            report('devtools-guard:' + name)
          },
          true
        )
      })(POINTER_EVENTS[i])
    }

    /* Selection is suppressed everywhere EXCEPT real inputs. A proxied console
     * has search boxes, filter fields and command inputs; locking those makes
     * the application unusable, and breaking the target to protect it is not a
     * trade this feature is allowed to make. */
    function isEditable(node) {
      if (!node) return false
      var tag = node.tagName ? String(node.tagName).toLowerCase() : ''
      return tag === 'input' || tag === 'textarea' || node.isContentEditable === true
    }
    document.addEventListener(
      'selectstart',
      function (e) {
        if (!isEditable(e.target)) swallow(e)
      },
      true
    )
    try {
      var st = document.createElement('style')
      st.setAttribute('data-pam-guard', 'selection')
      st.appendChild(
        document.createTextNode(
          '*{-webkit-user-select:none!important;user-select:none!important;}' +
            'input,textarea,[contenteditable]{-webkit-user-select:text!important;user-select:text!important;}'
        )
      )
      ;(document.head || document.documentElement).appendChild(st)
    } catch (x) {
      /* a page with no head yet still gets the event-level guard above */
    }

    /* ---- friction: keyboard -------------------------------------------
     * F12, Ctrl/Cmd+Shift+I/J/C/K (DevTools panels), Ctrl+U (view source),
     * Ctrl+S (save page), Ctrl+P (print), Ctrl+C/X/V (clipboard).
     *
     * Chrome and Edge consume F12 and Ctrl+Shift+I in the BROWSER process
     * before the page sees a keydown, and no page can touch the three-dots
     * menu at all. Cancelling these removes the reflex, not the door. The
     * detection below is what notices when the door was used anyway.
     */
    document.addEventListener(
      'keydown',
      function (e) {
        var key = String(e.key || '').toLowerCase()
        var hit = null
        if (key === 'f12' || e.keyCode === 123) {
          hit = 'f12'
        } else if (e.ctrlKey || e.metaKey) {
          if (e.shiftKey && (key === 'i' || key === 'j' || key === 'c' || key === 'k')) {
            hit = 'mod-shift-' + key
          } else if (!e.shiftKey && (key === 'u' || key === 's' || key === 'p' || key === 'c' || key === 'x' || key === 'v')) {
            hit = 'mod-' + key
          }
        }
        if (!hit) return
        swallow(e)
        report('devtools-guard:key:' + hit)
        check()
      },
      true
    )

    /* ---- signal 1: docked panel ---------------------------------------
     * Measured against a baseline taken at install, not a raw threshold: a
     * bookmarks bar or downloads shelf already eats 100 to 200px before
     * DevTools is involved. Page zoom moves innerWidth too, and Chrome reports
     * that as a devicePixelRatio change, so a DPR change re-takes the baseline
     * instead of being read as a panel.
     */
    var baseW = window.outerWidth - window.innerWidth
    var baseH = window.outerHeight - window.innerHeight
    var baseDpr = window.devicePixelRatio

    function rebaseline() {
      baseW = window.outerWidth - window.innerWidth
      baseH = window.outerHeight - window.innerHeight
      baseDpr = window.devicePixelRatio
    }

    function dockedOpen() {
      if (window.devicePixelRatio !== baseDpr) {
        rebaseline()
        return false
      }
      return (
        window.outerWidth - window.innerWidth - baseW > DOCKED_PX ||
        window.outerHeight - window.innerHeight - baseH > DOCKED_PX
      )
    }

    /* ---- signal 2: debugger timing ------------------------------------
     * Catches an undocked panel, which signal 1 is blind to. Built from a
     * string so a Content-Security-Policy without 'unsafe-eval' fails here
     * once and degrades to the other two signals, instead of throwing on every
     * tick forever. Many proxied targets ship exactly such a policy.
     */
    var pauseProbe = null
    try {
      pauseProbe = new Function('debugger')
    } catch (x) {
      pauseProbe = null
    }

    function debuggerPaused() {
      if (!pauseProbe) return false
      try {
        var t0 = Date.now()
        pauseProbe()
        return Date.now() - t0 > PAUSE_MS
      } catch (x) {
        return false
      }
    }

    /* ---- signal 3: console getter -------------------------------------
     * The weakest of the three: it reports nothing while the operator sits on
     * the Network tab. A fresh probe every call, because a shared one latches
     * on first fire and would pin the page in the blocked state forever.
     */
    function consoleOpen() {
      try {
        if (document.visibilityState === 'hidden') return false
        var hit = false
        var probe = {}
        Object.defineProperty(probe, 'id', {
          configurable: true,
          get: function () {
            hit = true
            return ''
          },
        })
        console.log(probe)
        return hit
      } catch (x) {
        return false
      }
    }

    function detect() {
      if (dockedOpen()) return 'docked'
      if (debuggerPaused()) return 'debugger'
      if (consoleOpen()) return 'console'
      return null
    }

    /* ---- the block ---------------------------------------------------- */

    function paint() {
      var host = document.body || document.documentElement
      if (!host) return
      var box = document.getElementById(OVERLAY_ID)
      if (!box) {
        box = document.createElement('div')
        box.id = OVERLAY_ID
        host.appendChild(box)
      }
      box.setAttribute('role', 'alertdialog')
      box.setAttribute('aria-live', 'assertive')
      box.style.cssText =
        'position:fixed;inset:0;z-index:2147483647;display:flex;align-items:center;' +
        'justify-content:center;padding:24px;background:#0a0c10;color:#e6e9ef;' +
        'font:400 15px/1.55 ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;' +
        '-webkit-user-select:none;user-select:none'

      var card = document.createElement('div')
      card.style.cssText =
        'max-width:460px;width:100%;text-align:center;border:1px solid #232833;' +
        'border-radius:12px;background:#11141b;padding:32px 28px;' +
        'box-shadow:0 18px 48px rgba(0,0,0,0.55)'

      var parts = [
        ['Developer Tools detected', 'font-size:19px;font-weight:600;color:#f4f6fa;margin-bottom:10px'],
        ['Close Developer Tools to continue.', 'color:#aab2c0;margin-bottom:6px'],
        ['This event has been recorded against your session.', 'color:#aab2c0'],
        [
          'This page reloads by itself once Developer Tools is closed.',
          'margin-top:18px;font-size:13px;color:#6f7887',
        ],
      ]
      for (var j = 0; j < parts.length; j++) {
        var el = document.createElement('div')
        el.appendChild(document.createTextNode(parts[j][0]))
        el.style.cssText = parts[j][1]
        card.appendChild(el)
      }

      while (box.firstChild) box.removeChild(box.firstChild)
      box.appendChild(card)
    }

    function trip(signal) {
      if (tripped) return
      tripped = true
      trippedAt = Date.now()

      /* Reported before the wipe. sendBeacon survives a teardown, but there is
       * no reason to race it. On a brokered page this lands in the audit trail
       * next to the operator, the session and the resource, which is what makes
       * the overlay's claim true. */
      report('devtools:' + signal)

      try {
        window.stop()
      } catch (x) {
        /* not implemented everywhere; the wipe below is what matters */
      }

      /* Empties the Elements panel of the TARGET application's markup and stops
       * it rendering further. It does not, and cannot, touch what the Network
       * panel already recorded. */
      try {
        document.documentElement.innerHTML = '<head></head><body></body>'
        document.title = 'Developer Tools detected'
      } catch (x) {
        /* fall through: paint() renders onto whatever is left */
      }

      paint()

      if (checkTimer) {
        clearInterval(checkTimer)
        checkTimer = null
      }
      recoveryTimer = setInterval(recover, RECOVER_MS)
    }

    function recover() {
      if (!tripped) return
      if (Date.now() - trippedAt < MIN_BLOCK_MS) return
      /* Every signal, not just the one that tripped. Recovering on a subset is
       * how a reload loop is built: trip on console, wipe, see docked clear,
       * reload, trip again, forever. */
      if (detect()) return
      try {
        window.location.reload()
      } catch (x) {
        /* the block stays up, which is the safe direction to fail in */
      }
    }

    function check() {
      if (tripped) return
      var signal = detect()
      if (!signal) {
        streak = 0
        return
      }
      streak++
      /* A signal must hold for CONFIRM_TICKS consecutive checks. One transient
       * reading during a window drag must never wipe an operator's working
       * session on a live production console. */
      if (streak >= CONFIRM_TICKS) trip(signal)
    }

    window.addEventListener('resize', check, false)
    checkTimer = setInterval(check, CHECK_MS)
    check()
  } catch (e) {
    /* Breaking the target application to protect it is not a trade this
     * feature is allowed to make. */
  }
})()
