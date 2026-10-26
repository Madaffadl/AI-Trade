import type { Config } from 'tailwindcss';

const config: Config = {
  content: ['./src/**/*.{ts,tsx}'],
  darkMode: 'class',
  theme: {
    extend: {
      /**
       * Palette validated with the dataviz skill's checker, not eyeballed:
       *   node scripts/validate_palette.js "#13a383,#e5484d,#3d8bfd,#b07d10" \
       *     --mode dark --surface "#0b0e13"   ->  ALL CHECKS PASS
       *
       * Two measured problems drove the changes from the first pass:
       *  - up/down were #3fb950/#e5534b: deuteranopia ΔE 4.6, far below the 8
       *    target and even the 6 floor. Red/green is the finance convention, so
       *    the green was moved toward teal (#13a383) rather than abandoned:
       *    ΔE 8.2 now clears the target while still reading as "up".
       *  - ink-faint was #5a6677: 3.1:1 on raised surfaces, failing WCAG AA for
       *    the smallest text in the app (timestamps, notes, disclaimers).
       *    #788598 is 4.84:1 and keeps three distinct text levels (16 / 6.1 / 4.8).
       *
       * Colour is never the only cue: every up/down value also carries a ▲/▼
       * glyph and a signed number, per the status-colour rule.
       */
      colors: {
        bg: { DEFAULT: '#0b0e13', raised: '#111620', inset: '#070a0e' },
        line: { DEFAULT: '#1e2633', strong: '#2c3747' },
        ink: { DEFAULT: '#e6eaf0', muted: '#8b97a8', faint: '#788598' },
        up: { DEFAULT: '#13a383', dim: '#0c3a30' },
        down: { DEFAULT: '#e5484d', dim: '#45191b' },
        flat: { DEFAULT: '#8b97a8' },
        accent: { DEFAULT: '#3d8bfd', dim: '#16283f' },
        warn: { DEFAULT: '#b07d10', dim: '#33250a' },
      },
      fontFamily: {
        sans: ['ui-sans-serif', 'system-ui', '-apple-system', 'Segoe UI', 'Roboto', 'sans-serif'],
        mono: ['ui-monospace', 'SFMono-Regular', 'Menlo', 'Consolas', 'monospace'],
      },
      /**
       * Type scale: 12 / 13 / 14 / 16 / 18 / 20 / 24.
       *
       * The previous scale started at 11px (`2xs`), and 11px was not an accent
       * size - it was the app's DEFAULT: 230 of the 297 text-size utilities in
       * src/ were `text-2xs`. Body copy below 12px fails the typography floor,
       * so the whole scale was lifted rather than the call sites rewritten.
       * `2xs` now sits exactly on the 12px floor and still reads as the "small"
       * tier because the tiers above it moved up with it.
       *
       * Line heights are unitless-equivalent ratios of ~1.4-1.5 so that text
       * still reflows when a user overrides spacing (WCAG 1.4.12).
       */
      fontSize: {
        '2xs': ['0.75rem', { lineHeight: '1.05rem' }],
        xs: ['0.8125rem', { lineHeight: '1.15rem' }],
        sm: ['0.875rem', { lineHeight: '1.3rem' }],
        base: ['1rem', { lineHeight: '1.5rem' }],
        lg: ['1.125rem', { lineHeight: '1.6rem' }],
        xl: ['1.25rem', { lineHeight: '1.75rem' }],
        '2xl': ['1.5rem', { lineHeight: '2rem' }],
      },
      transitionDuration: {
        DEFAULT: '180ms',
      },
    },
  },
  plugins: [],
};
export default config;
