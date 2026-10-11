/** @type {import('tailwindcss').Config} */
//
// ---------------------------------------------------------------------------
// Design system
// ---------------------------------------------------------------------------
// Two vocabularies live here on purpose.
//
// 1. SEMANTIC names (app, surface, subtle, line, primary, secondary, accent,
//    danger, warn, ok). Everything written in this pass uses these. They say
//    what a colour is FOR, so a token change repaints the product and no
//    component has to know a shade number.
//
// 2. The RAMP names the console shipped with (surface-950 … surface-600,
//    ink-50 … ink-600). Roughly 2000 call sites across 78 files still use
//    them. They are kept, and re-pointed at the new token values in
//    src/index.css, so the palette change lands everywhere at once instead of
//    leaving half the app on the old greys while it is migrated screen by
//    screen. New code should not reach for them.
//
// Scales EXTEND Tailwind's defaults rather than replacing them. Replacing was
// tried first and is stricter, but it silently drops every off-scale utility
// already in the codebase (text-2xl, p-3.5, rounded-2xl, space-y-5), and a
// utility that does not compile fails invisibly: the layout just goes wrong.
// Discipline for new work is held by review and by the semantic names above.
//
// TYPE. Every step below is one notch larger than the shipped console. This
// is read for hours on large monitors, and 11 to 13px body copy reads as
// cramped rather than dense. The workhorse table row is now 14px, labels are
// 12px, body prose is 15px, page titles 22px.
export default {
  content: ['./index.html', './src/**/*.{js,jsx}'],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        // ---- semantic (use these) ----------------------------------------
        // Names match the design system the mockups were built against, so a
        // screen can be ported from the mockup to the product without a
        // translation step in between.
        app: 'rgb(var(--bg-app) / <alpha-value>)',
        canvas: 'rgb(var(--bg-app) / <alpha-value>)',
        panel: 'rgb(var(--bg-surface) / <alpha-value>)',
        well: 'rgb(var(--bg-subtle) / <alpha-value>)',
        subtle: 'rgb(var(--bg-subtle) / <alpha-value>)',
        hover: 'rgb(var(--bg-hover) / <alpha-value>)',
        // Text roles. `text-primary` is the reading colour, `text-secondary`
        // supporting copy, `text-tertiary` chrome and labels.
        primary: 'rgb(var(--text-primary) / <alpha-value>)',
        secondary: 'rgb(var(--text-secondary) / <alpha-value>)',
        tertiary: 'rgb(var(--text-tertiary) / <alpha-value>)',
        // Two divider strengths, because a container edge and a table row
        // divider are not the same line. line is the edge, line-soft is the
        // divider inside a container, line-strong is a form control at rest.
        line: 'rgb(var(--border) / <alpha-value>)',
        'line-soft': 'rgb(var(--border-soft) / <alpha-value>)',
        'line-strong': 'rgb(var(--border-strong) / <alpha-value>)',
        accent: {
          DEFAULT: 'rgb(var(--accent) / <alpha-value>)',
          hover: 'rgb(var(--accent-hover) / <alpha-value>)',
          // Foreground for anything sitting ON an accent fill.
          on: 'rgb(var(--accent-on) / <alpha-value>)',
          soft: 'rgb(var(--accent-soft) / <alpha-value>)',
          active: 'rgb(var(--accent-active) / <alpha-value>)',
        },
        disabled: 'rgb(var(--text-disabled) / <alpha-value>)',
        // Product chrome: the top bar, dark in both themes.
        chrome: {
          DEFAULT: 'rgb(var(--chrome-bg) / <alpha-value>)',
          fg: 'rgb(var(--chrome-fg) / <alpha-value>)',
          muted: 'rgb(var(--chrome-muted) / <alpha-value>)',
          line: 'rgb(var(--chrome-line) / <alpha-value>)',
          hover: 'rgb(var(--chrome-hover) / <alpha-value>)',
        },
        danger: {
          DEFAULT: 'rgb(var(--danger) / <alpha-value>)',
          soft: 'rgb(var(--danger-soft) / <alpha-value>)',
          fill: 'rgb(var(--danger-fill) / <alpha-value>)',
        },
        warn: {
          DEFAULT: 'rgb(var(--warn) / <alpha-value>)',
          soft: 'rgb(var(--warn-soft) / <alpha-value>)',
        },
        ok: {
          DEFAULT: 'rgb(var(--ok) / <alpha-value>)',
          soft: 'rgb(var(--ok-soft) / <alpha-value>)',
        },

        // ---- shipped ramps, re-pointed at the new tokens ------------------
        // DEFAULT gives `bg-surface`, the panel plane, alongside the numbered
        // steps the existing screens still use.
        surface: {
          DEFAULT: 'rgb(var(--bg-surface) / <alpha-value>)',
          1000: 'rgb(var(--surface-1000) / <alpha-value>)',
          950: 'rgb(var(--surface-950) / <alpha-value>)',
          900: 'rgb(var(--surface-900) / <alpha-value>)',
          850: 'rgb(var(--surface-850) / <alpha-value>)',
          800: 'rgb(var(--surface-800) / <alpha-value>)',
          750: 'rgb(var(--surface-750) / <alpha-value>)',
          700: 'rgb(var(--surface-700) / <alpha-value>)',
          600: 'rgb(var(--surface-600) / <alpha-value>)',
        },
        ink: {
          50: 'rgb(var(--ink-50) / <alpha-value>)',
          100: 'rgb(var(--ink-100) / <alpha-value>)',
          200: 'rgb(var(--ink-200) / <alpha-value>)',
          300: 'rgb(var(--ink-300) / <alpha-value>)',
          400: 'rgb(var(--ink-400) / <alpha-value>)',
          500: 'rgb(var(--ink-500) / <alpha-value>)',
          600: 'rgb(var(--ink-600) / <alpha-value>)',
        },
      },

      fontFamily: {
        sans: ['IBM Plex Sans', 'ui-sans-serif', 'system-ui', '-apple-system', 'Segoe UI', 'Roboto', 'sans-serif'],
        mono: ['IBM Plex Mono', 'ui-monospace', 'SFMono-Regular', 'Menlo', 'monospace'],
      },

      fontSize: {
        // 11px survives for one job only: the uppercase tracking-wide eyebrow
        // over a group of fields. Nothing readable is set at this size.
        '2xs': ['0.6875rem', { lineHeight: '1rem', letterSpacing: '0.04em' }],
        // 12px. Column headers, meta chips, helper text.
        micro: ['0.75rem', { lineHeight: '1rem', letterSpacing: '0.04em' }],
        xs: ['0.8125rem', { lineHeight: '1.125rem' }],   // 13, dense meta
        sm: ['0.875rem', { lineHeight: '1.25rem' }],     // 14, grid rows and controls
        base: ['0.9375rem', { lineHeight: '1.375rem' }], // 15, body prose
        lg: ['1.125rem', { lineHeight: '1.375rem', letterSpacing: '-0.01em' }],  // 18, container title
        xl: ['1.25rem', { lineHeight: '1.5rem', letterSpacing: '-0.015em' }],    // 20, section
        '2xl': ['1.5rem', { lineHeight: '1.875rem', letterSpacing: '-0.02em' }], // 24, page title
        '3xl': ['1.75rem', { lineHeight: '2.125rem', letterSpacing: '-0.02em' }],  // 28
        // The single hero number on a screen. Never more than one per view.
        display: ['2rem', { lineHeight: '2.25rem', letterSpacing: '-0.022em' }],
      },

      boxShadow: {
        // Elevation defaults to nothing. A hairline border separates a panel
        // from the page; only something that genuinely floats gets a shadow.
        card: 'var(--shadow-card)',
        raised: 'var(--shadow-raised)',
        pop: 'var(--shadow-pop)',
        overlay: 'var(--shadow-overlay)',
        // A frozen table column needs a hint of depth so the boundary between
        // frozen and scrolling is visible rather than implied.
        frozen: 'var(--shadow-frozen)',
      },

      // Containers get a noticeably larger radius than the controls inside
      // them, which is what signals "this is a different kind of thing".
      // Cloudscape: container 16px, input and dropdown 8px, badge 4px.
      borderRadius: {
        DEFAULT: '0.5rem',
        md: '0.5rem',
        lg: '0.5rem',
        xl: '1rem',
        '2xl': '1rem',
      },

      maxWidth: {
        content: '1560px',
        prose: '74ch',
      },

      transitionTimingFunction: {
        emphasis: 'cubic-bezier(0.16, 1, 0.3, 1)',
        entrance: 'cubic-bezier(0.16, 1, 0.3, 1)',
      },

      zIndex: {
        sticky: '20',
        drawer: '40',
        modal: '50',
        palette: '55',
        toast: '60',
      },

      keyframes: {
        'fade-in': { from: { opacity: '0' }, to: { opacity: '1' } },
        'panel-in': {
          from: { opacity: '0', transform: 'translateY(6px) scale(0.995)' },
          to: { opacity: '1', transform: 'none' },
        },
        'sheet-in': { from: { transform: 'translateY(100%)' }, to: { transform: 'none' } },
        'drawer-in': {
          from: { opacity: '0', transform: 'translateX(16px)' },
          to: { opacity: '1', transform: 'none' },
        },
      },
      animation: {
        'fade-in': 'fade-in 130ms ease-out',
        'panel-in': 'panel-in 160ms cubic-bezier(0.16, 1, 0.3, 1)',
        'sheet-in': 'sheet-in 200ms cubic-bezier(0.16, 1, 0.3, 1)',
        'drawer-in': 'drawer-in 170ms cubic-bezier(0.16, 1, 0.3, 1)',
      },
    },
  },
  plugins: [],
}
