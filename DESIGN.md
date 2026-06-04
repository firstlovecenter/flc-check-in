# FLC Check-In — design system

**Source spec:** [`DESIGN-new.md`](DESIGN-new.md) (FL Admin Portal). This file describes how Hineni implements it.

**Hineni KB:** [`kb/hineni/07-design-system.md`](kb/hineni/07-design-system.md) — agent-oriented design rules for this repo.

Aligned with the **FL Admin Portal** frontend spec: pink-red brand
(`#FF4266`), cool gray canvas, **Outfit** typeface, HSL tokens in `src/design-tokens.css`,
and legacy CSS aliases in `src/index.css` so existing screens keep working without a
full shadcn migration.

## Principles

1. **Portal parity.** Same semantic tokens as the admin app (background, primary,
   success/warning/destructive) so Hineni feels like one product family.
2. **Color carries meaning.** Brand pink is for primary actions, focus, and links.
   Saturated greens/ambers/reds are reserved for *attendance status* (present / late /
   absent / checked-out).
3. **Light-first + system.** Default is light; users can cycle **Light → Dark → System**
   via the theme toggle (`localStorage['flc-theme']`).
4. **Glanceable.** Tabular figures on counts, generous touch targets, calm motion.

## Tokens

| File | Role |
|---|---|
| `src/design-tokens.css` | HSL channel triplets — single source of truth |
| `src/index.css` | Tailwind `@theme`, legacy `--bg`/`--present`/… aliases, utilities |

### Legacy aliases (components use these today)

- `--bg` / `--bg2` / `--text` / `--muted` — resolved full colors
- `--card`, `--border`, `--accent-surface`, `--muted-surface` in `design-tokens.css` are
  **HSL channels only** — use `hsl(var(--card))` in raw CSS, or Tailwind `bg-card`, `bg-accent`
- Legacy `--accent` / `--muted` are **resolved ink colors** (primary pink, muted text) — never
  assign `--card: hsl(var(--card))` or overwrite channel tokens in `index.css`
- `--accent` / `--cta-bg` / `--cta-text` → portal `--primary`
- `--present` / `--late` / `--absent` / `--out` → success / warning / destructive / slate
- `--badge-*` → portal feature accents (members, churches, arrivals, …)

### Tailwind utilities (new code)

Prefer Tailwind classes mapped in `@theme`: `bg-background`, `text-foreground`,
`bg-primary`, `text-muted-foreground`, `rounded-xl`, `shadow-sm`, etc.

## Typography

- **Outfit** (300–700) from Google Fonts in `index.html`.
- **Mono stack** for PINs and codes via `var(--mono)`.
- Class `.tnum` or `tabular-nums` for metrics, countdowns, PINs.

## Theme

- `src/lib/theme.ts` — resolve preference, apply `data-theme`, update `theme-color` meta.
- `src/hooks/useTheme.ts` — React hook; cycle toggle in `NavDrawer` and public QR header.
- Inline script in `index.html` prevents flash on load.

## Components & utilities

Unchanged utility classes: `.btn-pill`, `.input-field`, `.card`, `.eyebrow`,
`.drawer-panel`, `.modal-card`, `.sheet-card`.

## Rules of thumb

- Status color must match semantics (checked-out = `--out`, not amber).
- QR module and face-capture fills stay high-contrast / functional, not themed chrome.
- Respect `prefers-reduced-motion` (global).
- For new UI, prefer Tailwind + tokens; avoid hard-coded hex in components.

## Further alignment (optional)

`DESIGN-new.md` also describes shadcn/ui, Formik, Apollo, and `AppShell` — adopt those
incrementally if the check-in app grows admin-style surfaces.
