# Ink & Paper — FLC Check-In design system

A field instrument for presence. The app is used by leaders and members to
check in at events, often glancing at a phone at arm's length in bright
daylight, and by admins watching live attendance. The interface should read
like a precise instrument, not a brochure.

Supersedes the previous Mastercard-inspired warm-cream system.

## Principles

1. **Near-monochrome ink on paper.** Surfaces are tinted neutrals; text is a
   warm-cool ink. Chroma is reserved almost entirely for *attendance status*.
2. **Color carries meaning.** The only saturated color a user sees is status:
   present / late / absent / checked-out. If a color isn't telling you about
   attendance (or focus), it shouldn't be saturated.
3. **Light-first.** Light is the default for daylight legibility; a real dark
   theme is kept for evening services. Theme is a manual toggle persisted to
   `localStorage['flc-theme']` (`dark` = opt-in override; no attribute = light).
4. **Glanceable.** High contrast, tabular figures for every count, generous
   touch targets, calm motion.

## Tokens

All tokens live in `src/index.css` as CSS custom properties. Components consume
them via `var(--…)`; the app is ~entirely token-driven, so the system is changed
by editing those tokens, not component code. All color is OKLCH; neutrals carry
a faint cool tint (hue ~258). Never use `#000`/`#fff` for surfaces or text.

### Color roles (per theme: `:root` = light, `[data-theme="dark"]`)
- `--bg` / `--bg2` / `--card` — paper canvas, recessed surface, card surface
- `--border` — hairline dividers (preferred over shadow on the light UI)
- `--text` / `--muted` — ink, secondary ink
- `--accent` — **focus rings and links only**, not a decorative fill
- `--cta-bg` / `--cta-text` — primary pill (ink-on-paper light, paper-on-ink dark)

### Status (the load-bearing chroma)
- `--present` (green) · `--late` (amber) · `--absent` (red) · `--out` (slate)
- Legacy aliases kept: `--green`/`--amber`/`--coral` map to present/late/absent
- Tint backgrounds: `--present-bg`, `--late-bg`, `--absent-bg`, `--info-bg`,
  `--neutral-bg`, `--out-bg`. For one-off tints use
  `color-mix(in oklab, var(--present) 14%, transparent)`.

### Church-level badges
`--badge-{bacenta,governorship,council,stream,campus,oversight,denomination}`,
plus `--badge-text` for legible text on any badge/accent fill in either theme.

### Scale, depth, motion
- Radius: `--radius-sm 8` · `--radius-btn 12` · `--radius-card 16` · `--radius-pill 999`
- Shadow: `--shadow-1/2/3` — restrained, cool-tinted; prefer borders on light
- Easing: `--ease-out` (enter/exit UI), `--ease-in-out` (on-screen movement),
  `--ease-drawer` (drawers/sheets)

## Typography
- **Geist** (UI) + **Geist Mono** (PINs, codes); loaded in `index.html`.
- Hierarchy through scale + weight contrast; tight negative tracking on large
  headers; sentence case (uppercase only for the small `.eyebrow` label).
- Add `tnum` (`font-variant-numeric: tabular-nums`) to any number that updates
  or aligns in a column: counts, metrics, countdowns, times, PINs.

## Components & utilities
- `.btn-pill` + `.btn-primary` / `.btn-secondary` — pressable pill; presses
  scale to `0.97`.
- `.input-field` — focus shows accent border + soft `--info-bg` ring.
- `.card` — bordered surface, `--shadow-1`.
- `.eyebrow` — small uppercase label with a leading dot.
- `.drawer-panel` / `.drawer-backdrop` — slide-in nav (enter via
  `@starting-style`, exit via `data-state="closed"`, interruptible).
- `.modal-card` / `.sheet-card` — centered scale / bottom-sheet entrance.

## Rules of thumb
- Don't reintroduce colored **side-stripe** borders on cards; show state with a
  leading status dot/chip on a full-bordered row.
- Don't pair a saturated color with another saturated color; let ink + one
  status color do the work.
- Status color should be semantically correct (e.g. checked-out is `--out`
  slate, not amber; an attendance bar is green/amber/red by rate).
- QR module colors and the face-capture fill light stay high-contrast /
  fixed on purpose — they're functional, not themed chrome.
- Respect `prefers-reduced-motion` (handled globally) and keep UI motion
  under ~300ms; never animate keyboard-repeated or camera-path actions.
