/**
 * JS alias for the design tokens defined in index.css.
 *
 * These are var() references, NOT literal colours — that is the whole point.
 * The dashboard styles almost everything with inline `style={{}}`, so if this
 * object held hex values (as it originally did) every one of its ~1,700 call
 * sites would be frozen in dark mode. Pointing it at the CSS custom properties
 * makes the theme switch reach all of them for free.
 *
 * Consequences to respect:
 *
 *  - You cannot append a hex alpha. `${CR.accent}30` used to yield #c2410c30;
 *    it now yields "var(--cr-accent)30", which is invalid CSS and fails
 *    silently. Use the pre-mixed CR.accent15/25/40/60 instead.
 *  - You cannot read these back as colours in JS (no canvas fillStyle, no
 *    string math). Nothing in the dashboard does; keep it that way.
 *  - CR values are only valid inside CSS contexts — style props, template
 *    literals that become CSS strings.
 *
 * Every key here has a matching --cr-* in index.css, defined for both themes.
 */
/**
 * Apply an opacity to a colour that may be a var() reference.
 *
 * The codebase used to write `${agColor}15` — appending a hex alpha pair to a
 * 6-digit hex. That silently produces garbage the moment the base is a var()
 * (`var(--cr-accent)15` is not a colour, so the browser drops the declaration
 * and the fill just disappears). color-mix works with both forms.
 *
 * @param pct 0-100. Roughly `hexAlpha / 255 * 100` if you're porting an old call.
 */
export const withAlpha = (color: string, pct: number) =>
  `color-mix(in srgb, ${color} ${pct}%, transparent)`;

export const CR = {
  // Surfaces
  bgSidebar: 'var(--cr-bg-sidebar)',
  bgMain: 'var(--cr-bg-main)',
  bgCard: 'var(--cr-bg-card)',
  bgCardHov: 'var(--cr-bg-card-hov)',
  bgSurf: 'var(--cr-bg-surf)',
  bgElevated: 'var(--cr-bg-elevated)',

  // Borders
  border: 'var(--cr-border)',
  borderBright: 'var(--cr-border-bright)',
  borderSub: 'var(--cr-border-sub)',

  // Accent
  accent: 'var(--cr-accent)',
  accentWarm: 'var(--cr-accent-warm)',
  accentLow: 'var(--cr-accent-low)',
  /** Pre-mixed accent fills — replacements for the old `${CR.accent}NN` trick. */
  accent15: 'var(--cr-accent-15)',
  accent25: 'var(--cr-accent-25)',
  accent30: 'var(--cr-accent-30)',
  accent40: 'var(--cr-accent-40)',
  accent60: 'var(--cr-accent-60)',
  /** Text/icons on top of an accent fill. White in both themes. */
  onAccent: 'var(--cr-on-accent)',

  // Text, brightest to dimmest
  cream: 'var(--cr-cream)',
  text: 'var(--cr-text)',
  sub: 'var(--cr-sub)',
  mutedBr: 'var(--cr-muted-br)',
  muted: 'var(--cr-muted)',
  placeholder: 'var(--cr-placeholder)',

  // Status
  green: 'var(--cr-green)',
  greenLow: 'var(--cr-green-low)',
  greenLine: 'var(--cr-green-line)',
  amber: 'var(--cr-amber)',
  amberLow: 'var(--cr-amber-low)',
  amberLine: 'var(--cr-amber-line)',
  blue: 'var(--cr-blue)',
  blueLow: 'var(--cr-blue-low)',
  purple: 'var(--cr-purple)',
  purpleLow: 'var(--cr-purple-low)',
  purpleLine: 'var(--cr-purple-line)',
  red: 'var(--cr-red)',
  redLow: 'var(--cr-red-low)',
  redLine: 'var(--cr-red-line)',

  /**
   * Foreground washes over a surface, faintest to strongest. White on dark,
   * warm ink on light — so "slightly lighter than the card" automatically
   * becomes "slightly darker than the card" in light mode. Use these instead
   * of rgba(255,255,255,0.0x).
   */
  tint1: 'var(--cr-tint-1)',
  tint2: 'var(--cr-tint-2)',
  tint3: 'var(--cr-tint-3)',
  tint4: 'var(--cr-tint-4)',
  tint5: 'var(--cr-tint-5)',
  tint6: 'var(--cr-tint-6)',
  line: 'var(--cr-line)',
  lineStr: 'var(--cr-line-str)',

  /** Recessed surfaces — inputs, code blocks. Not black in light mode. */
  well: 'var(--cr-well)',
  wellStr: 'var(--cr-well-str)',

  // Depth
  scrim: 'var(--cr-scrim)',
  shadowSm: 'var(--cr-shadow-sm)',
  shadowMd: 'var(--cr-shadow-md)',
  shadowLg: 'var(--cr-shadow-lg)',

  // Syntax highlighting
  synKey: 'var(--cr-syntax-key)',
  synStr: 'var(--cr-syntax-str)',
  synNum: 'var(--cr-syntax-num)',
  synCom: 'var(--cr-syntax-com)',
  synFn: 'var(--cr-syntax-fn)',

  // Type
  serif: "'DM Serif Display', serif",
  sans: "'DM Sans', sans-serif",
  mono: "'JetBrains Mono', monospace",
};
