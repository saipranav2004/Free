/** @type {import('tailwindcss').Config} */
// Phase 4 design system, expressed as the only tokens available to the mockups.
// If a value isn't here, it isn't in the system — that's the point.
export default {
  content: ['./index.html', './src/**/*.{js,jsx}'],
  darkMode: 'class',
  theme: {
    // NOTE: these REPLACE Tailwind's defaults rather than extending them, so
    // an off-scale value (text-2xl, p-3.5, shadow-lg, rounded-full on a card)
    // simply does not compile. The system is enforced by the toolchain.
    fontSize: {
      micro: ['0.6875rem', { lineHeight: '1rem', letterSpacing: '0.06em' }], // 11
      xs: ['0.75rem', { lineHeight: '1rem' }], // 12
      sm: ['0.8125rem', { lineHeight: '1.25rem' }], // 13 — workhorse
      base: ['0.875rem', { lineHeight: '1.25rem' }], // 14
      lg: ['1rem', { lineHeight: '1.5rem', letterSpacing: '-0.01em' }], // 16
      xl: ['1.25rem', { lineHeight: '1.75rem', letterSpacing: '-0.01em' }], // 20
      display: ['1.75rem', { lineHeight: '2rem', letterSpacing: '-0.02em' }], // 28
    },
    fontWeight: {
      normal: '400',
      semibold: '600',
    },
    spacing: {
      0: '0px',
      px: '1px',
      0.5: '2px',
      1: '4px',
      2: '8px',
      3: '12px',
      4: '16px',
      6: '24px',
      8: '32px',
      12: '48px',
      16: '64px',
      // SIZING-ONLY steps (heights, widths, glyphs). These are deliberately
      // NOT available as padding or margin — spacing stays on the 4px grid.
      // 1.5 (6px) is the status dot; 3.5 (14px) is the small glyph size;
      // both are optical sizes, not layout rhythm.
      1.5: '6px',
      3.5: '14px',
      5: '20px',
      7: '28px',
      9: '36px',
      10: '40px',
      11: '44px',
      14: '56px',
      24: '96px',
      40: '160px',
      60: '240px',
    },
    borderRadius: {
      none: '0',
      sm: '4px',
      DEFAULT: '6px',
      md: '6px',
      lg: '8px',
      xl: '10px',
      full: '9999px',
    },
    boxShadow: {
      none: 'none',
      // Level 2 only. There is no card/button shadow in this system.
      overlay: '0 8px 24px -8px rgb(0 0 0 / 0.18), 0 2px 6px -2px rgb(0 0 0 / 0.10)',
    },
    extend: {
      colors: {
        app: 'rgb(var(--bg-app) / <alpha-value>)',
        surface: 'rgb(var(--bg-surface) / <alpha-value>)',
        subtle: 'rgb(var(--bg-subtle) / <alpha-value>)',
        hover: 'rgb(var(--bg-hover) / <alpha-value>)',
        line: 'rgb(var(--border) / <alpha-value>)',
        'line-strong': 'rgb(var(--border-strong) / <alpha-value>)',
        primary: 'rgb(var(--text-primary) / <alpha-value>)',
        secondary: 'rgb(var(--text-secondary) / <alpha-value>)',
        tertiary: 'rgb(var(--text-tertiary) / <alpha-value>)',
        accent: 'rgb(var(--accent) / <alpha-value>)',
        'accent-hover': 'rgb(var(--accent-hover) / <alpha-value>)',
        'accent-soft': 'rgb(var(--accent-soft) / <alpha-value>)',
        danger: 'rgb(var(--danger) / <alpha-value>)',
        'danger-soft': 'rgb(var(--danger-soft) / <alpha-value>)',
        warn: 'rgb(var(--warn) / <alpha-value>)',
        'warn-soft': 'rgb(var(--warn-soft) / <alpha-value>)',
        ok: 'rgb(var(--ok) / <alpha-value>)',
        'ok-soft': 'rgb(var(--ok-soft) / <alpha-value>)',
      },
      fontFamily: {
        sans: ['Inter', 'ui-sans-serif', 'system-ui', '-apple-system', 'Segoe UI', 'Roboto', 'sans-serif'],
        mono: ['JetBrains Mono', 'ui-monospace', 'SFMono-Regular', 'Menlo', 'monospace'],
      },
      maxWidth: {
        content: '1440px',
        prose: '72ch',
      },
      transitionTimingFunction: {
        entrance: 'cubic-bezier(0.16, 1, 0.3, 1)',
      },
    },
  },
  plugins: [],
}
