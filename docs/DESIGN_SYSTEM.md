# Design System — "Editorial Industrial"

_Last updated: 2026-10-09_

AdForge Studio's visual identity is deliberately distinct from BhavishAI's
mystical ivory/gold + purple. This product reads as **creative-studio /
production software**: ink, warm bone and a single rationed signal orange, with
a video **frame / crop-mark** motif and monospace technical metadata.

> Brand DNA: **Ink + Bone + Signal Orange + Frame Motif.**
> Recognition target: *black + warm white + orange → this product.*

## Tokens (semantic, role-based)

Defined in `app/globals.css` as CSS variables and exposed to Tailwind via
`@theme inline` (so utilities like `bg-surface`, `text-ink`, `border-line`,
`text-accent` work). Dark mode is its own elevation ladder — **not** a mechanical
inversion — toggled by the `.dark` class (set from `prefers-color-scheme` by a
pre-paint script in `app/layout.js`).

| Role | Light | Dark | Tailwind |
|---|---|---|---|
| Background (warm bone / near-black) | `#F7F6F2` | `#0D0E10` | `bg-bg` |
| Surface | `#FFFFFF` | `#151619` | `bg-surface` |
| Raised surface | `#FFFFFF` | `#1D1E22` | `bg-raised` |
| Primary text (ink) | `#111214` | `#F5F4EF` | `text-ink` |
| Secondary text | `#6C6D70` | `#97989E` | `text-muted` |
| Border (architectural) | `#DFDFDB` | `#292A2F` | `border-line` |
| **Signal orange** | `#FF5A24` | `#FF6840` | `text-accent` / `bg-accent` |
| Accent hover | `#E94816` | `#FF7A54` | `bg-accent-hover` |

Orange is used **sparingly** — CTAs, selected states, the frame motif, key
metrics, generation/AI accents — never as a fill-everything gradient.

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

- Theme follows the OS only; there is no in-app light/dark toggle yet (easy to
  add — flip the `.dark` class on `<html>`).
- A dedicated SVG logo/favicon using the frame motif is a design direction, not
  yet shipped as an asset (the `◩` glyph stands in).
