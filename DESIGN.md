---
name: Cortex Gateway
description: Visual identity of cortex-gateway.dev and product surfaces (status page, consent screens). Dev-tool aesthetic — modern, sober, fast.
colors:
  ink: "#111827"
  muted: "#6b7280"
  line: "#e5e7eb"
  bg: "#ffffff"
  bg-soft: "#f9fafb"
  code-bg: "#f3f4f6"
  signal: "#059669"
  ink-dark: "#e5e7eb"
  muted-dark: "#9ca3af"
  line-dark: "#27272a"
  bg-dark: "#0b0b0d"
  bg-soft-dark: "#18181b"
  code-bg-dark: "#27272a"
  signal-dark: "#34d399"
typography:
  body: { fontFamily: "system-ui, -apple-system, 'Segoe UI', sans-serif", fontSize: 16.5px, lineHeight: 1.65 }
  h1: { fontFamily: "system-ui, -apple-system, 'Segoe UI', sans-serif", fontSize: 30px, fontWeight: 700, lineHeight: 1.25 }
  h2: { fontFamily: "system-ui, -apple-system, 'Segoe UI', sans-serif", fontSize: 21px, fontWeight: 700 }
  h3: { fontFamily: "system-ui, -apple-system, 'Segoe UI', sans-serif", fontSize: 17px, fontWeight: 700 }
  lead: { fontFamily: "system-ui, -apple-system, 'Segoe UI', sans-serif", fontSize: 18px }
  brand: { fontFamily: "ui-monospace, 'Cascadia Code', 'SF Mono', Menlo, Consolas, monospace", fontWeight: 600 }
  code: { fontFamily: "ui-monospace, 'Cascadia Code', 'SF Mono', Menlo, Consolas, monospace", fontSize: 14px }
  code-block: { fontFamily: "ui-monospace, 'Cascadia Code', 'SF Mono', Menlo, Consolas, monospace", fontSize: 13.5px, lineHeight: 1.5 }
rounded:
  sm: 4px
  md: 8px
spacing:
  content-max: 760px
  section: 40px
  card: 16px
components:
  cta:
    backgroundColor: "{colors.ink}"
    textColor: "#ffffff"
    rounded: "{rounded.md}"
    hoverBackgroundColor: "{colors.signal}"
  card:
    borderColor: "{colors.line}"
    rounded: "{rounded.md}"
  tldr:
    backgroundColor: "{colors.bg-soft}"
    borderColor: "{colors.line}"
    rounded: "{rounded.md}"
  logo-mark:
    coreColor: "{colors.signal}"
    nodeColor: "{colors.ink}"
---

## Overview

Dev-tool minimalism: near-black ink on white, generous line-height, one
narrow reading column, real HTML, zero JavaScript. The register is
infrastructure documentation, not marketing — the page should feel like a
well-kept README that happens to be a website. The identity is deliberately
**standalone**: cortex-gateway does not borrow the palette, fonts or
components of any sibling project or house brand.

One signature: the **federation node mark** (a signal-green core connected
to four ink nodes). It reads as both a synapse (cortex) and the gateway's
hub-and-spoke topology. It is intentionally NOT a brain — literal brains are
the most saturated cliché in AI branding and fail at favicon size.

## Colors

Monochrome does the work; **signal green is the only accent** and it is
scarce by design. It appears in exactly three places: the logo core, link
hover states, and the CTA hover. It never colors body text, headings,
backgrounds or borders. Everything ships in light AND dark (via
`prefers-color-scheme`); the dark variants are first-class tokens, not an
afterthought filter.

## Typography

Two families, strict roles. The system stack carries all prose (fast, no
webfont request, native rendering). The monospace stack carries code AND the
brand wordmark (`cortex-gateway` in the header) — that monospace wordmark is
half of the "dev" look. Never introduce a third family; never use monospace
for prose.

## Layout

Single 760px column, 24px side padding, 40px section rhythm. Navigation is
one flat header line (brand + 4-5 links), footer is one centered line.
Two-column card grids (`.grid`) collapse to one column under 640px. Wide
content (tables, code) scrolls horizontally inside its own container — the
page body never scrolls sideways.

## Elevation & Depth

None. No shadows, no glows, no gradients. Depth is expressed with 1px
borders (`line`) and soft background tints (`bg-soft`, `code-bg`) only.

## Shapes

Radii: 4px (inline code) and 8px (cards, blocks, buttons, TL;DR). Nothing
rounder — no pills, no circles except the logo nodes.

## Components

- **CTA**: ink background, white text, 8px radius; hover flips to signal
  green. **One primary CTA per page** — it always points to action
  (GitHub, demo), never to another content page.
- **TL;DR box**: `bg-soft` + border, opens every content page; the label is
  small-caps muted.
- **Cards**: bordered links (title + one muted line), used for hub
  navigation grids.
- **Tables**: full-width, 1px borders, `bg-soft` header row — used for
  comparisons and troubleshooting.
- **Logo mark**: `site/assets/logo.svg` (self-adapting to color scheme; also
  the favicon). Render at 20px in the header next to the monospace wordmark.

## Do's and Don'ts

- **Do** keep pages static, hand-written HTML with inline JSON-LD — no
  build step, no client JS. This is a feature, not a shortcut.
- **Do** ship every element in both color schemes; test dark mode before
  committing.
- **Do** start content pages with breadcrumbs + H1 + TL;DR box.
- **Don't** import palettes, fonts or components from sibling projects —
  this identity is standalone by decision.
- **Don't** use signal green on text, backgrounds or borders; it is a
  highlight, not a theme.
- **Don't** add gradients, glows, purple-card hero sections, emoji strings
  or more than one CTA per page (anti AI-slop).
- **Don't** draw a literal brain anywhere. The federation node IS the
  cortex metaphor.
- **Don't** add a webfont; the system and monospace stacks are the brand.
