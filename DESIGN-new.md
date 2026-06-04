# Frontend Design System

A reusable blueprint of the FL Admin Portal frontend (`web-react-ts/`). Use this document as a starting spec when building **new apps** that should share the same look, feel, architecture, and conventions.

> The portal is mid-migration: a **new Tailwind v4 + shadcn/ui design system** is the target, and legacy plain CSS / Bootstrap remnants are being phased out. **For new apps, build only on the "new system" described here** — ignore the legacy patterns unless you are specifically maintaining old screens.

---

## 1. Tech Stack

| Category | Choice | Version |
|---|---|---|
| Framework | React | `^18.1.0` |
| Language | TypeScript (strict) | `^4.7.x` |
| Build tool | **Vite** (not CRA) | `^5.4.x` |
| Path aliases | `vite-tsconfig-paths` (`baseUrl: "src"`) | — |
| Routing | React Router v6 | `^6.30.x` |
| Data layer | Apollo Client + GraphQL | `@apollo/client ^3.8`, `graphql ^16.8` |
| Global state | React Context API (no Redux/Zustand) | — |
| Forms | Formik + Yup | `formik ^2.2`, `yup ^0.32` |
| Styling | **Tailwind CSS v4** + **shadcn/ui** (Radix) | `tailwindcss ^4.2` |
| Class utils | `class-variance-authority`, `tailwind-merge`, `clsx` | — |
| Icons | `lucide-react` (primary), `@tabler/icons-react`, `react-icons` | — |
| Tables | `@tanstack/react-table` | `^8.21` |
| Charts | `recharts` | `^2.1` |
| Toasts | `sonner` | `^2.0` |
| Motion | `motion` (Framer Motion successor) | `^12.x` |
| Dates | Native `Date` + custom `lib/date-utils.ts` (no moment/dayjs) | — |
| Auth | **Custom JWT microservice** (NOT Auth0, despite the dep being present) | — |
| Error monitoring | `@sentry/react` | — |
| PWA | `vite-plugin-pwa` (Workbox) | — |
| Testing | Vitest + Testing Library + MSW | — |

**Key scripts:**

```bash
npm start        # vite dev server (port 3000)
npm run build    # tsc && vite build
npm test         # vitest
```

---

## 2. Project Structure

Feature-first organization. Shared building blocks live in `components/`, cross-cutting logic in `contexts/`, `hooks/`, `lib/`. Each feature owns its routes, GraphQL, and sub-components.

```
src/
├── index.tsx                 # App bootstrap (imports app.css only)
├── AppWithContext.tsx        # Router + context providers + shell layout
├── SimpleApp.tsx             # Auth gate (splash → login vs app)
├── app.css                   # Tailwind v4 entry + @theme mapping + @font-face
├── design-tokens.css         # SINGLE SOURCE OF TRUTH for colors (HSL channels)
├── global-types.ts           # Shared TS types (Role, LazyRouteTypes, …)
│
├── auth/                     # Route guards, role checks, permission bootstrap
├── contexts/                 # AuthContext, ChurchContext, MemberContext, …
├── hooks/                    # use* hooks
├── lib/                      # Apollo client factory, auth-service, date-utils
├── assets/                   # SVGs, icon components
│
├── components/
│   ├── ui/                   # shadcn/ui primitives (button, card, dialog, …)
│   ├── shell/                # AppShell, Sidebar, ThemeProvider, SearchPalette
│   ├── formik/               # Formik field wrappers over shadcn inputs
│   ├── base-component/       # ApolloWrapper, LoadingScreen, ErrorScreen
│   └── lib/utils.ts          # cn() helper
│
└── pages/                    # One folder per feature module
    └── <feature>/
        ├── <Feature>Routes.ts        # LazyRouteTypes[] export
        ├── *Queries.ts / *Mutations.ts
        ├── reusable-forms/
        └── <SubComponents>.tsx
```

### Conventions to replicate

- **Path aliases:** import from `src/` bare, e.g. `import { Button } from 'components/ui/button'`. Set `baseUrl: "src"` in `tsconfig.json` + `vite-tsconfig-paths`.
- **Feature-first:** colocate routes, GraphQL docs, forms, and sub-components inside `pages/<feature>/`.
- **New shared UI** → `components/ui/` (shadcn) and `components/shell/`.

---

## 3. Design Tokens (Colors)

**`design-tokens.css` is the single source of truth.** All colors are stored as **HSL channel triplets** (`H S% L%`) so Tailwind opacity modifiers (`bg-primary/90`) work. `app.css` maps each token into Tailwind's `@theme` as `--color-*`, which auto-generates `bg-*`, `text-*`, `border-*` utilities.

### Brand

| Token | Value | ~Hex | Role |
|---|---|---|---|
| `--brand` / `--primary` / `--ring` | `349 100% 63%` | **#FF4266** | Brand pink-red — primary actions, focus rings, accents |
| `--brand-foreground` / `--primary-foreground` | `0 0% 100%` | #FFFFFF | Text on brand |

### Semantic scale — Light (`:root`)

| Token | HSL | ~Hex |
|---|---|---|
| `--background` | `215 20% 95%` | #EEF1F5 |
| `--foreground` | `220 14% 10%` | #161A1F |
| `--card` / `--popover` | `210 20% 99%` | #FCFDFE |
| `--secondary` / `--muted` / `--accent` | `214 14% 94%` | #ECEEF1 |
| `--muted-foreground` | `215 12% 47%` | #6B7280 |
| `--destructive` | `0 84% 60%` | #EF4444 |
| `--success` | `142 71% 45%` | #22C55E |
| `--warning` | `38 92% 50%` | #F59E0B |
| `--border` / `--input` | `214 14% 89%` | #E2E6EB |

### Semantic scale — Dark (`[data-theme='dark']`)

| Token | HSL | ~Hex |
|---|---|---|
| `--background` | `222 14% 7%` | #0F1114 |
| `--foreground` | `210 20% 96%` | #F1F4F7 |
| `--card` / `--popover` | `220 13% 10%` | #16181C |
| `--secondary` / `--muted` / `--accent` | `217 10% 16%` | #25272B |
| `--border` / `--input` | `217 10% 18%` | #2A2D31 |

> Brand (`--primary`) stays the same pink-red in both modes. Feature accents brighten slightly in dark mode for contrast.

### Feature accent colors

Domain areas have dedicated accents (used by `StatCard`, charts, nav). Light-mode values:

| Token | HSL | ~Hex |
|---|---|---|
| `--members` | `174 63% 40%` | #26A69A (teal) |
| `--churches` | `262 52% 50%` | #7C3AED (violet) |
| `--arrivals` | `231 48% 50%` | #4359C8 (indigo) |
| `--defaulters` | `25 95% 48%` | #F97316 (orange) |
| `--banking` | `142 71% 38%` | #16A34A (green) |
| `--campaigns` | `270 67% 50%` | #8B2FD6 (purple) |
| `--maps` | `199 89% 42%` | #0EA5E9 (sky) |

### Chart palette (5 colors)

`--chart-1`..`--chart-5` = brand pink, members teal, churches violet, banking green, defaulters orange.

### Sidebar tokens

`--sidebar-background`, `--sidebar-foreground`, `--sidebar-primary`, `--sidebar-accent`, `--sidebar-border`, `--sidebar-ring` — let the nav theme independently from page surfaces.

### Token file skeleton (copy into a new app)

```css
/* design-tokens.css */
:root {
  --brand: 349 100% 63%;
  --brand-foreground: 0 0% 100%;
  --background: 215 20% 95%;
  --foreground: 220 14% 10%;
  --card: 210 20% 99%;
  --card-foreground: 220 14% 10%;
  --primary: 349 100% 63%;
  --primary-foreground: 0 0% 100%;
  --secondary: 214 14% 94%;
  --muted: 214 14% 94%;
  --muted-foreground: 215 12% 47%;
  --accent: 214 14% 94%;
  --destructive: 0 84% 60%;
  --success: 142 71% 45%;
  --warning: 38 92% 50%;
  --border: 214 14% 89%;
  --input: 214 14% 89%;
  --ring: 349 100% 63%;
  --radius: 0.625rem;
  /* feature accents, sidebar, chart-* … */
}

[data-theme='dark'] {
  --background: 222 14% 7%;
  --foreground: 210 20% 96%;
  /* … dark overrides … */
}
```

---

## 4. Typography

- **Font family:** **Outfit** (self-hosted WOFF2 in `/public/fonts/`, weights 300–700, `font-display: swap`).
- **Stack:** `'Outfit', system-ui, -apple-system, BlinkMacSystemFont, sans-serif` (exposed to Tailwind as `--font-sans` → `font-sans`).
- Applied to `body` in an `@layer base` block so everything inherits it.

### Type scale in practice (Tailwind utilities)

| Use | Classes |
|---|---|
| Large metric / hero number | `text-3xl font-semibold tracking-tight tabular-nums` |
| Card title | `font-semibold leading-none tracking-tight` |
| Body | default (`text-base`) |
| Secondary / labels | `text-sm font-medium text-muted-foreground` |
| Hints / captions | `text-xs text-muted-foreground` |
| Tiny pills | `text-[11px]` |

Always pair numeric displays with `tabular-nums`.

---

## 5. Spacing, Radius, Shape

- **Spacing:** Tailwind default scale (`p-4`, `gap-3`, `space-y-1.5`). Cards use `p-6` headers/content; compact tiles use `p-3`.
- **Radius:** base `--radius: 0.625rem` (10px), with scale:
  - `rounded-sm` = `--radius - 4px`
  - `rounded-md` = `--radius - 2px`
  - `rounded-lg` = `--radius`
  - `rounded-xl` = `--radius + 4px`
  - Cards use `rounded-xl`; buttons/inputs use `rounded-md`.
- **Shadows:** subtle only — `shadow-xs` (controls), `shadow-sm` (cards/floating buttons).
- **Form control heights:** shadcn default input/button `h-9` (36px); Formik inputs bump to `min-h-11` (44px) for touch targets.

---

## 6. Theming & Dark Mode

Theme is driven by a `data-theme="light|dark"` attribute on `<html>`, managed by `components/shell/ThemeProvider.tsx`.

- Preference stored in `localStorage` key **`flc-theme`** (`light | dark | system`).
- `system` follows `prefers-color-scheme` via a `matchMedia` listener.
- Also updates the PWA `<meta name="theme-color">` (`#fafafa` light / `#09090b` dark).
- During migration it ALSO sets `data-bs-theme` to keep Bootstrap synced — **drop this line in a greenfield app.**
- Tailwind v4 dark variant is declared explicitly in `app.css`:

```css
@custom-variant dark (&:where([data-theme='dark'], [data-theme='dark'] *));
```

Consume via the `useTheme()` hook: `{ theme, preference, setPreference, toggleTheme }`.

---

## 7. Component Library

### Pattern: shadcn/ui ("new-york" style, CSS variables)

Primitives in `components/ui/` (~33): `button`, `input`, `textarea`, `select`, `checkbox`, `radio-group`, `switch`, `label`, `card`, `dialog`, `alert-dialog`, `sheet`, `drawer`, `popover`, `dropdown-menu`, `tabs`, `accordion`, `table`, `badge`, `avatar`, `breadcrumb`, `skeleton`, `progress`, `scroll-area`, `tooltip`, `command`, `alert`, `sonner`, `sidebar`.

**House rules for every primitive:**
- One file per primitive, lowercase kebab filename (`alert-dialog.tsx`).
- `React.forwardRef` where a ref is useful.
- Props extend the native element type + CVA `VariantProps`.
- Compose classes with `cn()` (clsx + tailwind-merge).
- Add `data-slot` / `data-variant` attributes for styling hooks.
- Variants via `class-variance-authority`.

### The `cn` helper (required)

```ts
// components/lib/utils.ts
import { type ClassValue, clsx } from 'clsx'
import { twMerge } from 'tailwind-merge'

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}
```

### Button — canonical CVA example

```tsx
const buttonVariants = cva(
  "inline-flex shrink-0 items-center justify-center gap-2 rounded-md text-sm font-medium whitespace-nowrap transition-all outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-50 [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  {
    variants: {
      variant: {
        default: "bg-primary text-primary-foreground hover:bg-primary/90",
        destructive: "bg-destructive text-white hover:bg-destructive/90",
        outline: "border bg-background shadow-xs hover:bg-accent hover:text-accent-foreground",
        secondary: "bg-secondary text-secondary-foreground hover:bg-secondary/80",
        ghost: "hover:bg-accent hover:text-accent-foreground",
        link: "text-primary underline-offset-4 hover:underline",
      },
      size: {
        default: "h-9 px-4 py-2",
        xs: "h-6 gap-1 rounded-md px-2 text-xs",
        sm: "h-8 gap-1.5 rounded-md px-3",
        lg: "h-10 rounded-md px-6",
        icon: "size-9",
      },
    },
    defaultVariants: { variant: "default", size: "default" },
  }
)
```

Supports `asChild` (Radix `Slot`) to render as a custom element while keeping styles.

### Card — surface primitive

```tsx
// Card root
'rounded-xl border border-border bg-card text-card-foreground shadow-sm'
// CardHeader: 'flex flex-col space-y-1.5 p-6'
// CardTitle:  'font-semibold leading-none tracking-tight'
// CardContent:'p-6 pt-0'
// CardFooter: 'flex items-center p-6 pt-0'
```

Exports `Card, CardHeader, CardTitle, CardDescription, CardContent, CardFooter`.

### StatCard — domain pattern (metric tiles)

A custom component built on `Card` showing the accent-color convention. Key ideas worth copying:
- Accepts an `accent` prop mapped to feature colors via lookup objects (`bg-members/10` + `text-members`).
- Icon sits in a tinted rounded square (`size-10 rounded-lg bg-<accent>/10`), icon `size-5 text-<accent>`.
- Delta pill: `bg-success/15 text-success` (up) or `bg-destructive/15 text-destructive` (down).
- `compact` prop renders a horizontal tile on mobile (`md:hidden`) and a hero tile on desktop (`hidden md:block`).
- `loading` swaps the value for a `<Skeleton>`.

---

## 8. App Shell & Layout

`components/shell/AppShell.tsx` is the authenticated layout wrapper.

- Root: `flex h-screen overflow-hidden bg-background`.
- **Desktop (`md+`):** persistent `<Sidebar>` (`hidden shrink-0 md:block`) + scrollable content column (`flex-1 ... overflow-y-auto`).
- **Mobile (`<md`):** floating circular toggle (top-right, `size-11 rounded-full`) opens a `<Sheet>` drawer (`<MobileNav>`); optional PWA `<BackButton>` top-left.
- **Command palette:** global `Cmd/Ctrl+K` opens `<SearchPalette>`. The shortcut is ignored while focus is in `INPUT`/`TEXTAREA`/`SELECT`/contentEditable.

`md:` (768px) is the **primary responsive breakpoint** — design mobile-first, then layer `md:` for the desktop sidebar split.

---

## 9. Routing

- React Router v6 + `BrowserRouter`. Routes are **lazy-loaded** (`React.lazy`) and declared as typed arrays per feature, aggregated in `AppWithContext.tsx`.
- Route shape:

```ts
export interface LazyRouteTypes {
  path: string
  element: LazyExoticComponent<() => JSX.Element>
  placeholder?: boolean
  roles: Role[]   // role-based access; 'all' = any authenticated user
}
```

- Example module:

```ts
export const dashboards: LazyRouteTypes[] = [
  { path: '/', element: UserDashboard, placeholder: true, roles: ['all'] },
  { path: '/dashboard/servants', element: ServantsDashboard, roles: ['all'] },
]
```

- Layout nesting: `ThemeProvider → Router → <context providers> → SetPermissions → Routes`, where most routes render inside `<AppShell>` wrapped by `<ProtectedRoute roles={...}>`. A `*` route renders `PageNotFound`.

---

## 10. State Management

Context API only — one provider per concern, composed at the app root. Mirror this for new apps:

| Context | Purpose |
|---|---|
| `AuthContext` | JWT auth: login/logout, silent token refresh, `isAuthenticated` |
| `MemberContext` (`currentUser`) | Signed-in user profile, roles, jobs |
| Domain contexts (e.g. `ChurchContext`) | Selected entity IDs; persisted to `sessionStorage` |
| `ThemeProvider` | light/dark/system theme |

For a generic app, keep `AuthContext` + `UserContext` + `ThemeProvider`, and add domain contexts as needed.

---

## 11. Data Fetching (Apollo / GraphQL)

Apollo Client created in `lib/createApolloClient.tsx` with link chain:

```
errorLink → retryLink → authLink → httpLink
```

- **authLink** attaches `Authorization: Bearer <JWT>` per request (calls `getAccessTokenSilently()`).
- **retryLink** up to 5 attempts, only on transport / 5xx errors.
- **errorLink** surfaces failures via `sonner` toasts.
- `errorPolicy: 'all'` by default.
- Endpoint from env (`VITE_*_GRAPHQL_URI`).

**Conventions:**
- GraphQL documents live in `*Queries.ts` / `*Mutations.ts`, exported as `SCREAMING_SNAKE_CASE` consts via `gql`.
- Pages call `useQuery` / `useMutation`, then gate rendering with the shared `<ApolloWrapper loading error data>` (renders `LoadingScreen` / `ErrorScreen` / children).

```tsx
const { data, loading, error } = useQuery(DISPLAY_STREAM, { variables: { id } })
const [RecordService] = useMutation(RECORD_SERVICE)

return (
  <ApolloWrapper loading={loading} error={error} data={data}>
    <ServiceForm church={data?.streams[0]} RecordServiceMutation={RecordService} />
  </ApolloWrapper>
)
```

---

## 12. Forms (Formik + Yup)

- Form state via **Formik**, validation via **Yup** schemas.
- Reusable field wrappers in `components/formik/` bridge Formik to shadcn inputs (`Input`, `Textarea`, `Select`, `RadioButtons`, `CheckboxGroup`, `FileUpload`/`ImageUpload`, GraphQL-backed `Search*` comboboxes, `SubmitButton`).
- Each wrapper: renders a `<Label>`, the shadcn control bound via Formik `<Field as={...}>`, sets `aria-invalid` on error, and shows `<ErrorMessage component={TextError}>`.

```tsx
function Input(props: InputProps) {
  const { label, name, className, ...rest } = props
  const [, meta] = useField(name)
  const showError = Boolean(meta.touched && meta.error)
  return (
    <div className="space-y-1.5">
      {label && <Label htmlFor={name}>{label}</Label>}
      <Field as={ShadcnInput} id={name} name={name}
        aria-invalid={showError || undefined}
        className={cn('min-h-11', className)} {...rest} />
      <ErrorMessage name={name} component={TextError} />
    </div>
  )
}
```

Typical form: `<Formik initialValues validationSchema={Yup.object({...})} onSubmit validateOnMount>` with a responsive `grid grid-cols-1 gap-4 md:grid-cols-2` field layout.

---

## 13. Auth

Custom JWT (NOT Auth0). Client in `lib/auth-service.ts`, context in `contexts/AuthContext.tsx`.

- Env `VITE_AUTH_API_URL` required (throws at load if missing).
- Tokens in `localStorage`: `fl_access_token`, `fl_refresh_token`, `fl_user`.
- Flow: `AuthProvider` verifies/refreshes on mount → `SimpleApp` shows splash then login if unauthenticated. Public routes: `/login`, `/signup`, `/forgot-password`, `/reset-password`, `/setup-password`.
- Apollo auth link auto-refreshes with a 5-minute expiry buffer.
- **Role-based access:** a `Role` union type; `ProtectedRoute roles={[...]}` guards routes; `permission-utils.ts` (`permitMe`, `permitAdmin`) and `<RoleView>` gate UI.

---

## 14. Conventions Cheat-Sheet

| Kind | Convention | Example |
|---|---|---|
| shadcn/ui files | lowercase kebab | `button.tsx`, `alert-dialog.tsx` |
| Domain components / pages | PascalCase | `CampusForm.tsx`, `UserDashboard.tsx` |
| Hooks | `use` + camelCase | `useChurchLevel.tsx` |
| Route exports | camelCase arrays of `LazyRouteTypes` | `export const dashboards` |
| Route files | `<feature>Routes.ts` | `directoryRoutes.ts` |
| GraphQL docs | `SCREAMING_SNAKE` consts in `*Queries.ts`/`*Mutations.ts` | `DISPLAY_STREAM` |
| Types/interfaces | PascalCase in `global-types.ts` or `*-types.ts` | `LazyRouteTypes` |
| Tests | colocated `*.test.tsx` | Vitest + RTL + MSW |

### Tooling config

- **TypeScript:** `baseUrl: "src"`, `strict: true`, `noImplicitAny`, `strictNullChecks`, `jsx: "react-jsx"`, `noEmit: true`, `allowJs: true`.
- **Prettier** (`.prettierrc.json`): `semi: false`, `singleQuote: true`, `trailingComma: "es5"`, `printWidth: 80`, `tabWidth: 2`.
- **ESLint:** extends `react-app`; `react/prop-types` off, `no-console: warn`.
- **lint-staged:** prettier → eslint → tsc on `*.{ts,tsx}`.

---

## 15. Build-a-New-App Checklist

1. **Scaffold:** Vite + React + TS. Add `vite-tsconfig-paths`, set `baseUrl: "src"`.
2. **Styling:** install Tailwind v4 (`@tailwindcss/vite`), create `app.css` (`@import 'tailwindcss'`) and `design-tokens.css`. Map tokens into `@theme inline` as `--color-*`. Declare the `dark` custom variant.
3. **Fonts:** self-host Outfit WOFF2 in `/public/fonts/`, add `@font-face`, set `--font-sans`.
4. **shadcn/ui:** init with "new-york" + CSS variables; pull primitives into `components/ui/`. Add `cn()` in `components/lib/utils.ts`.
5. **Shell:** build `ThemeProvider` (`data-theme` + `localStorage` `flc-theme`), `AppShell` (desktop sidebar / mobile sheet), and a `Cmd+K` command palette.
6. **Routing:** React Router v6, lazy routes typed as `LazyRouteTypes[]`, aggregated centrally, guarded by `ProtectedRoute`.
7. **Data:** Apollo Client with `errorLink → retryLink → authLink → httpLink`; colocate GraphQL per feature; gate with an `ApolloWrapper`.
8. **State:** Context providers (`Auth`, `User`, theme, domain) composed at root.
9. **Forms:** Formik + Yup with `components/formik/` wrappers over shadcn inputs (`min-h-11`, `aria-invalid`, `TextError`).
10. **Auth:** custom JWT service + `AuthContext`, tokens in `localStorage`, role-based guards.
11. **Quality:** Prettier (no semicolons, single quotes), ESLint `react-app`, Vitest + RTL + MSW, lint-staged.

### Aesthetic summary

Pink-red brand (`#FF4266`) on a cool neutral gray canvas, **Outfit** typeface, generous `rounded-xl` cards with `shadow-sm`, restrained shadows, per-domain accent colors, and a first-class dark mode. Mobile-first with a single `md:` breakpoint splitting mobile drawer from desktop sidebar.
