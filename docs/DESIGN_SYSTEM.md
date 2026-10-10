# Design System — "Editorial Industrial"

_Last updated: 2026-10-10_

MakeAdClips Studio's visual identity is deliberately distinct from BhavishAI's
mystical ivory/gold + purple. This product reads as **creative-studio /
production software**: ink, warm bone and a single rationed signal orange, with
a video **frame / crop-mark** motif and monospace technical metadata.

> Brand DNA: **Ink + Bone + Signal Orange + Frame Motif.**
> Recognition target: *black + warm white + orange → this product.*

## Tokens (semantic, role-based)

Defined in `app/globals.css` as CSS variables (`--background`, `--surface`,
`--foreground`, …) and exposed to Tailwind via `@theme inline` (so utilities
like `bg-surface`, `text-ink`, `border-line`, `text-accent`, `text-danger`,
`bg-success-surface` work). Dark mode is its own elevation ladder — **not** a
mechanical inversion — toggled by the `.dark` class on `<html>`.

**Theme is driven by [`next-themes`](https://github.com/pacocoursey/next-themes)**
(`attribute="class"`, `defaultTheme="system"`, `enableSystem`,
`disableTransitionOnChange`, `storageKey="makeadclips-theme"`), wired through
`components/theme/ThemeProvider.js` in the root layout. The library injects a
pre-paint script, so there is no theme flash and no SSR/CSR hydration mismatch
on the `<html>` class. The user's choice (Light / Dark / System) persists in
`localStorage`; **System** reacts live to OS changes.

| Role | Light | Dark | Token / Tailwind |
|---|---|---|---|
| Background (warm bone / near-black) | `#F7F6F2` | `#0D0E10` | `--background` · `bg-bg` |
| Surface (white / charcoal) | `#FFFFFF` | `#151619` | `--surface` · `bg-surface` |
| Elevated surface | `#FFFFFF` | `#1D1E22` | `--surface-elevated` · `bg-raised` |
| Primary text (ink) | `#111214` | `#F5F4EF` | `--foreground` · `text-ink` |
| Secondary text | `#6C6D70` | `#97989E` | `--foreground-muted` · `text-muted` |
| Border (architectural) | `#DFDFDB` | `#292A2F` | `--border` · `border-line` |
| **Signal orange** (accent) | `#FF5A24` | `#FF6840` | `--accent` · `text-accent` / `bg-accent` |
| Accent hover | `#E94816` | `#FF7A54` | `--accent-hover` · `bg-accent-hover` |
| Danger | `#C0341D` | `#FF7A63` | `--danger` · `text-danger` (+ `bg-danger-surface`) |
| Warning | `#9A6400` | `#E3B65A` | `--warning` · `text-warning` (+ `bg-warning-surface`) |
| Success | `#1F7A4D` | `#5FCF93` | `--success` · `text-success` (+ `bg-success-surface`) |
| Media canvas (both themes) | `#0B0B0D` | `#0B0B0D` | `--canvas` · `.media-canvas` |

Orange is used **sparingly** — CTAs, selected states, the frame motif, key
metrics, generation/AI accents — never as a fill-everything gradient. The
**media canvas** (`--canvas`) stays neutral-dark in *both* themes so video /
creative previews read correctly even in light mode. Detected **customer brand
colors** are confined to the brand-profile / concept / preview surfaces (inline
`style`); they never recolor global navigation or theme tokens.

### Theme control & responsive nav

`components/theme/ThemeToggle.js` is a compact Light/Dark/System dropdown
(lucide `Sun`/`Moon`/`Monitor`) with an accessible label; it mount-gates
theme-dependent icons via `useSyncExternalStore` (`components/theme/useMounted.js`)
to avoid hydration mismatches. It lives in the shared `components/layout/AppHeader.js`
— inline in the desktop top nav, and inside the mobile hamburger menu
(`variant="inline"`, a 3-up radio group). The header is rendered once in the
root layout, so every route shares one navigation.

### Responsive & accessibility conventions

- Mobile-first; no horizontal overflow at 320–1440px (`html/body { overflow-x: hidden }`
  as a backstop). Verified at 320/375/390/430/768/1024/1280/1440.
- Interactive controls target ≥44px (`.btn`/`.input` `min-height: 44px`); inputs
  use ≥16px font to avoid iOS zoom-on-focus.
- Safe-area insets via `viewportFit=cover` + `env(safe-area-inset-*)` on the
  header and page bottoms.
- Status uses semantic `.alert` / `.alert-danger|warning|success` (never
  fixed-width); long strings wrap via `.break-anywhere`.
- Visible `:focus-visible` rings; `prefers-reduced-motion` disables animation
  and `next-themes` `disableTransitionOnChange` keeps theme switches flash-free.

## Typography

- **Primary:** Geist (modern grotesk sans) — does most of the branding work via
  large, tight `.display` headings (`font-weight 600`, `letter-spacing -0.02em`).
- **Monospace:** Geist Mono for technical/video metadata — `.mono-meta` and
  `.eyebrow` (uppercase, tracked). Used for readouts like:
  `00:08 SEC · 720P · 9:16 · OMNI FLASH · $0.80 EST.`

## Components (classes in `globals.css`)

- `.btn` + `.btn-primary` / `.btn-secondary` / `.btn-ghost` — squared
  (10–12px radii), architectural, not pills. Primary CTAs read
  `GENERATE VIDEO →`.
- `.card` / `.card-raised` — thin-border surfaces, 12px radius.
- `.input` — token-driven fields with an orange focus ring.
- `.accent-chip` / `.accent-dot` — small status accents.

## Brand motif: video frame / crop marks

- `.frame` draws two L-corners (top-left + bottom-right) on any container.
- `.frame-corners` + four `<span class="corner tl|tr|bl|br" />` children draws
  all four corners. Applied to upload zones, the generated-video card, the empty
  result state, and the landing hero graphic. Also the logo lockup (`◩`).

## Motion

Precise, not bouncy: short transitions, a `.sweep` linear loader. No spring/
overshoot animations.

## Usage guidance

- Marketing surfaces may lean more expressive; the **editor stays calm** (large
  negative space, generated product imagery provides most of the color).
- Keep orange rationed. If a screen looks orange-heavy, demote accents to
  `text-ink`/`text-muted` and reserve orange for the single primary action.
- Don't reintroduce gold, purple or a blue/purple "AI gradient" — those belong
  to BhavishAI, not this product.

## Known limitations

- Theme preference persists only in `localStorage` (no account sync yet — that
  arrives with auth). "System" follows the OS and updates live.
- A dedicated SVG logo/favicon using the frame motif is a design direction, not
  yet shipped as an asset (the `◩` glyph stands in).
- `/projects` and `/assets` are themed "coming soon" placeholders
  (`components/layout/ComingSoon.js`) so nav links are live, not dead — the real
  screens ship with persistence/auth.
