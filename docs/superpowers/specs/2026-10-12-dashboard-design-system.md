# Dashboard Design System

Applies to `dashboard/` (Manager view and Console). Derived with ui-ux-pro-max (style: Dark Mode OLED + Real-Time Monitoring; Financial Dashboard number animations) on top of the Qdrant brand, which fixes colors and fonts. Contrast and palette numbers were computed, not eyeballed.

## Style

- **Dark, high-contrast, real-time monitoring.** Deep background, elevated surfaces, one glow at a time. The screen is read from 2 to 3 meters in a booth aisle and on a projector.
- **Motion means something happened.** Every animation starts from a state change the poll observed in Qdrant (spec section 6). Nothing moves for decoration, nothing loops except the live indicator.
- **One story at a time.** At most two elements animate together per view; the document journey owns the stage while it plays.

## Color tokens

| Token | Value | Use | Contrast on `#0B0F19` |
|---|---|---|---|
| `--bg` | `#0B0F19` | page | |
| `--surface-1` | `#111824` | cards, panels | |
| `--surface-2` | `#141A2A` | nested, inputs | |
| `--surface-3` | `#212635` | popovers, the active node | |
| `--border` | `#4E5366` | dividers, card borders | |
| `--text` | `#F0F3FA` | all primary text | 17.2 |
| `--text-muted` | `#ABB1C7` | secondary text, labels | 9.0 |
| `--text-faint` | `#656B7F` | decoration and large text only (fails 4.5 for body text) | 3.6 |
| `--red` | `#DC244C` | fills, marks, primary button, over-plan meter (not text: 4.0) | |
| `--red-text` | `#FF8792` | red text, over-plan labels | 8.3 |
| `--violet` | `#6047FF` | fills, focus ring base (not text: 3.5) | |
| `--violet-text` | `#C2C5FF` | violet text, links | 11.6 |
| `--n8n` | `#EA4B71` | n8n nodes and the "why n8n" sentences | |

**Status (reserved for budget meters, always with an icon and a label):** within plan `#009688`, near plan (85% or more used) `#FF9800`, over plan `#DC244C`. A meter track is the same hue at 20% opacity.

**Lenses (categorical, validated with the dataviz palette script on `#111824`, all checks pass):** Keyword `#039BE5`, Line `#7C66FF`, Meaning `#43A047`. Every lens is also labeled by name; color is never the only cue. The fused result uses the brand gradient `#DC244C → #6047FF` as a bar or border, never on text.

## Typography

- **Mona Sans** for UI; **Geist Mono** for keys (`PO-1042`), amounts, timings, and request JSON. Numbers use `font-variant-numeric: tabular-nums`.
- Booth scale (1920 × 1080 at 2 to 3 m): hero figure 112 px / 600; section titles 32 px / 600, letter-spacing -0.5 px; card titles 24 px; body 20 px; labels 16 px minimum. Console may go one step smaller.
- Amounts: `132,000 €` style (English UI, euro sign after, thousands separators); rough reads show what was read (`132 €`) so the correction is visible.
- No gradient text (brand rule). `font-display: swap`.

## Layout

- **Manager view** (`/`), chosen layout "office map with a spotlight": header (brand, manager pills, live indicator), five stat tiles, then a 2 × 2 map beside a 600 px column. The map's first tile is the **spotlight** (a failed read, else the document being read, else a fresh duplicate or amendment, else the latest document: the paper, the hero amount, stages 01 to 04 with timings, the read-once cost); the other three tiles are the manager's offices, one Qdrant point each. The column holds Ask the memory (query, threshold, Keyword, Line, Meaning, fused) above the tape.
- **Kiosk stage:** both views render on a fixed 1920 × 1080 canvas scaled to the screen, so a projector, a TV, and a laptop show the same picture without scrolling; below 1000 px wide the layout stacks instead.
- **Console** (`/console`): controls on the left (send from the pool, start and stop the day, reset), the latest-document band on top, the n8n pipeline canvas filling the rest.
- Cards: 8 px radius (16 px for the hero band), 24 px padding, 1 px `--border`; hover shifts the border color only (no scale, no layout shift).
- Z-index scale: base 0, sticky header 10, toasts 30, modals 50.

## Motion

| Kind | Duration | Easing |
|---|---|---|
| Micro (hover, press, focus) | 150 to 200 ms | ease-out |
| State change (stage, meter fill, count-up) | 300 to 600 ms | ease-out entering, ease-in leaving |
| Story beat (document journey, lens beams, amendment) | 800 to 1400 ms, chained | ease-in-out, staggered 80 ms |

- Transform and opacity only; meters animate `scaleX`, not width.
- Count-up for figures that changed; strike-through plus slide for superseded amounts; a stamp for duplicates.
- `prefers-reduced-motion: reduce` turns every animation into an instant state change. Hidden tabs skip animations. Animations never gate data.

## Interaction and accessibility

- Visible focus ring: 2 px `--violet-text` outline, 2 px offset. Tab order follows the visual order.
- Targets at least 44 × 44 px; `cursor: pointer` on everything clickable; buttons disable and show progress while their request runs.
- The tape is an `aria-live="polite"` region. Over plan reads as icon plus "over by 12,000 €", not color alone.
- Icons: Lucide (SVG, 24 px grid, 1.75 stroke). No emoji as icons. Logos from the official Qdrant brand files and n8n's published logo.
- Server text renders as text, never as HTML.

## Anti-patterns

Light mode by default; gradient text; red as a large background; animating everything at once; infinite decorative animation; scale-on-hover; gray body text below 4.5:1; color as the only signal; spinners longer than a second where a skeleton fits.
