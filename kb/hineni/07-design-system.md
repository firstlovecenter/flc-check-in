# Hineni — design system

## Spec chain

1. **[DESIGN-new.md](../../DESIGN-new.md)** — FL Admin Portal tokens (source of truth for colors/type)
2. **[DESIGN.md](../../DESIGN.md)** — how Hineni maps spec to this repo
3. **Implementation** — `src/design-tokens.css`, `src/index.css`

## Brand

- Primary / brand pink: `349 100% 63%` → **#FF4266**
- Canvas: `--background` → `#EEF1F5` (light)
- Use **`bg-primary`**, **`text-primary`**, or **`hsl(var(--primary))`** in components
- Legacy alias `--accent` = full pink color — use as `var(--accent)`, never `hsl(var(--accent))`
- Tailwind `bg-accent` = gray **surface** (`--accent-surface`), not pink

## Tokens

| File | Role |
|------|------|
| `design-tokens.css` | HSL **channels** only for `--card`, `--primary`, … |
| `index.css` | `@theme` → Tailwind `--color-*`, utilities (`.btn-pill`, `.event-row`, …) |

**Critical:** `@theme` colors must be `hsl(var(--primary))` — not `hsl(var(--primary) / <alpha-value>)`
unless Tailwind compiles them (broken literal `<alpha-value>` breaks all brand colors).

## Theme

- `src/lib/theme.ts`, `src/hooks/useTheme.ts`
- `localStorage['flc-theme']`: light | dark | system
- `data-theme='dark'` on `<html>`

## UI kit (`src/components/ui/`)

| Component | Use |
|-----------|-----|
| `Button` | Primary actions — default variant is pink |
| `Card` | Surfaces — borderless + shadow in Hineni |
| `Input`, `Label`, `Textarea` | Forms |
| `Badge` | Status pills (`active` = pink ACTIVE event) |
| `Alert` | Success / destructive messages |

Prefer **Button** + Tailwind over new inline `style={{}}`.

## Layout

- `PageShell` — gray page background
- `PageMain` — content width
- `AuthLayout` — portal-aligned auth shell (ambient brand glow, grain, logo tile, glass card)
- `NavDrawer` — mobile nav (not portal sidebar)

## Status colors (attendance only)

Attendance is binary — exactly two statuses:

| Meaning | Token |
|---------|-------|
| Present | `--success` / `text-success` |
| Absent | `--destructive` |

Do not use pink for “live” attendance dots — green pulse on home event cards.

## Feature accents (scope badges)

Tailwind: `bg-members`, `bg-churches`, `bg-arrivals`, etc. — see `TopBar` `LEVEL_BADGE` map.
