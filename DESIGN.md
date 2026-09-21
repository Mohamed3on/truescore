---
name: TrueScore
description: The real score, everywhere. Honest review scores laid over the sites where you decide.
colors:
  night-glass: "rgba(14, 16, 24, 0.9)"
  night-ground: "#0a0c12"
  night-ground-popup: "#0d0f17"
  brass: "#E8B86D"
  sea-glass: "#6DD3CE"
  sea-glass-wash: "rgba(109, 211, 206, 0.1)"
  sea-glass-line: "rgba(109, 211, 206, 0.5)"
  positive: "#4ADE80"
  negative: "#F87171"
  ink-1: "rgba(255, 255, 255, 0.88)"
  ink-2: "rgba(255, 255, 255, 0.7)"
  ink-3: "rgba(255, 255, 255, 0.5)"
  ink-4: "rgba(255, 255, 255, 0.3)"
  ink-5: "rgba(255, 255, 255, 0.06)"
  hairline: "rgba(255, 255, 255, 0.07)"
  control: "rgba(255, 255, 255, 0.04)"
  control-line: "rgba(255, 255, 255, 0.08)"
  control-hover: "rgba(255, 255, 255, 0.08)"
  card-glass: "rgba(255, 255, 255, 0.03)"
  paper: "#FAFAF9"
  paper-tint: "#F5F5F4"
  paper-line: "#E7E5E4"
  white: "#FFFFFF"
  stone-ink: "#1C1917"
  stone-2: "#57534E"
  stone-3: "#78716C"
  stone-4: "#A8A29E"
  teal-ink: "#0F766E"
  teal-wash: "#F0FDFA"
  teal-line: "#99F6E4"
  praised-wash: "#F0FDF4"
  complaint-wash: "#FFF7ED"
  mark: "#FEF3C7"
typography:
  display:
    fontFamily: "'IBM Plex Mono', ui-monospace, 'SF Mono', monospace"
    fontSize: "56px"
    fontWeight: 600
    lineHeight: 1
    letterSpacing: "normal"
  headline:
    fontFamily: "'IBM Plex Mono', ui-monospace, 'SF Mono', monospace"
    fontSize: "26px"
    fontWeight: 600
    lineHeight: 1
    letterSpacing: "normal"
  title:
    fontFamily: "'Sora', system-ui, sans-serif"
    fontSize: "12px"
    fontWeight: 600
    lineHeight: 1.3
    letterSpacing: "0.04em"
  body:
    fontFamily: "'Sora', system-ui, sans-serif"
    fontSize: "11px"
    fontWeight: 400
    lineHeight: 1.5
    letterSpacing: "normal"
  label:
    fontFamily: "'IBM Plex Mono', ui-monospace, 'SF Mono', monospace"
    fontSize: "9px"
    fontWeight: 500
    lineHeight: 1.2
    letterSpacing: "0.12em"
  body-daylight:
    fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif"
    fontSize: "12px"
    fontWeight: 400
    lineHeight: 1.5
    letterSpacing: "normal"
  label-daylight:
    fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif"
    fontSize: "10.5px"
    fontWeight: 700
    lineHeight: 1.2
    letterSpacing: "0.06em"
rounded:
  bar: "2px"
  control: "6px"
  field: "8px"
  card: "12px"
  panel: "16px"
  pill: "999px"
spacing:
  xs: "4px"
  sm: "6px"
  md: "8px"
  lg: "12px"
  xl: "16px"
  panel: "18px"
components:
  panel-glass:
    backgroundColor: "{colors.night-glass}"
    textColor: "{colors.ink-1}"
    rounded: "{rounded.panel}"
    padding: "{spacing.panel}"
  card-glass:
    backgroundColor: "{colors.card-glass}"
    textColor: "{colors.ink-2}"
    rounded: "{rounded.card}"
    padding: "10px 12px"
  button-glass:
    backgroundColor: "{colors.control}"
    textColor: "{colors.ink-3}"
    typography: "{typography.body}"
    rounded: "{rounded.field}"
    padding: "8px"
  button-glass-hover:
    backgroundColor: "{colors.control-hover}"
    textColor: "{colors.ink-2}"
  input-glass:
    backgroundColor: "{colors.control}"
    textColor: "{colors.ink-1}"
    typography: "{typography.body}"
    rounded: "{rounded.field}"
    padding: "7px 10px"
  chip-glass:
    backgroundColor: "{colors.control}"
    textColor: "{colors.ink-1}"
    typography: "{typography.body}"
    rounded: "{rounded.pill}"
    padding: "5px 9px"
  chip-glass-active:
    backgroundColor: "{colors.sea-glass-wash}"
    textColor: "{colors.ink-1}"
  island-daylight:
    backgroundColor: "{colors.paper}"
    textColor: "{colors.stone-ink}"
    typography: "{typography.body-daylight}"
    rounded: "{rounded.field}"
    padding: "14px 16px"
  button-daylight:
    backgroundColor: "{colors.teal-wash}"
    textColor: "{colors.teal-ink}"
    typography: "{typography.body-daylight}"
    rounded: "{rounded.control}"
    padding: "7px 14px"
  input-daylight:
    backgroundColor: "{colors.white}"
    textColor: "{colors.stone-ink}"
    typography: "{typography.body-daylight}"
    rounded: "{rounded.control}"
    padding: "7px 10px"
  section-praised:
    backgroundColor: "{colors.praised-wash}"
    textColor: "{colors.stone-ink}"
    rounded: "{rounded.control}"
    padding: "8px 12px"
  section-complaints:
    backgroundColor: "{colors.complaint-wash}"
    textColor: "{colors.stone-ink}"
    rounded: "{rounded.control}"
    padding: "8px 12px"
---

# Design System: TrueScore

## Overview

**Creative North Star: "The Quiet Ledger"**

TrueScore is a ledger someone keeps beside the shop window: figures entered in a monospaced hand, ruled with hairlines, never decorated. It sits on other people's pages, so it never competes with them. It adds one calm instrument, states a number, and lets the number carry the argument. Everything else on the panel exists to make that figure legible and trustworthy: a nine-pixel label above it, a two-pixel bar under it, a one-line verdict beside it.

The ledger has two skins for two desks. On dark or busy hosts (Google Maps, Booking.com, the popup, the web app) it is **night glass**: a tinted near-black slab with backdrop blur, one signature hairline of brass fading to sea glass, and white ink stepped through a strict opacity ladder. On white retail pages (Amazon, Decathlon, Uniqlo, IKEA, dm, Etsy, AliExpress, BJJ Fanatics) it is **daylight paper**: a warm stone card in the host's own system font, teal for the one accent, and pale washes to sort praise from complaint. Both skins share the same grammar: mono, tabular numerals for every figure; uppercase micro-labels instead of headings; hairline rules instead of boxes; sentiment carried by green, amber, and red tints rather than fills. On Letterboxd, IMDb, and Goodreads the ledger borrows the host's palette and typeface outright and keeps only its grammar.

It is analytical, editorial, and quiet. It rejects the generic AI look (purple-to-blue gradients), gradient text, and blur used as decoration: blur is the material of the night-glass panel and nothing else.

**Key Characteristics:**
- Numbers lead: the figure is the largest element on any panel, set in IBM Plex Mono 600 with tabular numerals.
- Micro-labels, not headings: 9–10.5px uppercase tracked labels introduce every section.
- Hairlines over containers: 1px lines at 6–9% white (or a 1px dashed stone line on paper) separate groups; nested cards do not exist.
- One signature per panel: the brass-to-sea-glass gradient appears once, as a hairline or a bar fill.
- Sentiment is tinted, not filled: positive green, mid amber, negative red at 10–30% opacity behind text, full strength only on the figure itself.
- Motion is one exponential ease-out; bars grow, panels settle, nothing bounces.

## Colors

Two grounds, one signature pair, three sentiment hues, and an opacity ladder for ink; the daylight skin swaps the ground for warm stone and the signature for a single teal.

### Primary
- **Brass** (`brass`): the warm half of the signature. Alone it is the mid sentiment ("neither loved nor hated") and the star color on review cards. In the gradient it is the left end.
- **Sea Glass** (`sea-glass`): the cool half of the signature and the only interactive accent in the night skin: link underlines, the active chip's border and wash (`sea-glass-line`, `sea-glass-wash`), the selected segment in the popup. In the gradient it is the right end.
- **Teal Ink** (`teal-ink`): the daylight skin's single accent. Button text and border, focused input border, the count in "N of M reviews mention". Its wash (`teal-wash`) and line (`teal-line`) form the daylight button.

### Secondary
- **Positive** (`positive`) and **Negative** (`negative`): sentiment endpoints on the night skin. Full strength on a figure or a one-word verdict; 10–30% opacity as a tint behind bars and rails. On the daylight skin the gauge fill uses an HSL ramp from red through amber to green (hue 0→120, 70% saturation, 35% lightness) computed from the net score, so the two skins agree on meaning without sharing a value.
- **Praised Wash** and **Complaint Wash** (`praised-wash`, `complaint-wash`): the daylight summary's two section grounds, pale green and pale orange, with `teal-wash` for a named better alternative and `paper-tint` for the conclusion.
- **Mark** (`mark`): the search-term highlight, a pale amber behind matched words.

### Neutral
- **Night Glass** (`night-glass`): the panel surface, tinted toward blue-black so it is never pure black, at 90% opacity over a 24px blur.
- **Night Ground** (`night-ground`, `night-ground-popup`): page grounds behind the web app and the popup; two near-identical values ship today.
- **Ink ladder** (`ink-1` to `ink-5`): white at 88 / 70 / 50 / 30 / 6 percent. Primary text, secondary text, labels and disabled figures, tertiary marks, and the faintest rule. Each step is a rank; two elements at the same step are peers.
- **Hairline, Control, Control Line, Control Hover, Card Glass** (`hairline`, `control`, `control-line`, `control-hover`, `card-glass`): the night skin's surfaces at 3–8% white. Cards sit at 3%, controls at 4%, their borders at 8%, and hover only lifts a control to 8%.
- **Paper, Paper Tint, Paper Line** (`paper`, `paper-tint`, `paper-line`): the daylight island's ground, its conclusion block, and every border and dashed rule on it.
- **Stone ink** (`stone-ink`, `stone-2`, `stone-3`, `stone-4`): the daylight ladder. Body, secondary, labels and the island header, placeholders and dates.

### Named Rules
**The One Signature Rule.** The brass-to-sea-glass gradient appears once per panel, as the top hairline or a primary bar fill. A second use is a bug.
**The Tint Rule.** Sentiment colors sit behind text at 10–30% opacity or on a figure at full strength. They never fill a button, a chip, or a card.
**The Ladder Rule.** Ink is chosen by rank on the opacity ladder, never by eye. If two things share a step, they are peers on purpose.

## Typography

**Display Font:** IBM Plex Mono (with ui-monospace, SF Mono)
**Body Font:** Sora (with system-ui) on the night skin; the host's system stack on the daylight skin
**Label/Mono Font:** IBM Plex Mono for every figure, count, percent, and micro-label on the night skin

**Character:** A ledger hand next to a quiet editorial voice. Plex Mono at 500–600 makes every number look entered rather than styled; Sora at 300–400 keeps the prose light enough to defer to it. The daylight skin drops Sora and inherits the host's sans so the island reads as a native aside, but its figures stay tabular.

### Hierarchy
- **Display** (600, 56px, 1.0): the web app's place score. Nothing on that page is larger.
- **Headline** (600, 26px, 1.0): the panel figure on Maps cards; dimmed to `ink-4` while it counts up.
- **Title** (600, 12px, 0.04em): the panel title ("Review Intelligence", the place name row). On the daylight skin the island header is `label-daylight` at 10.5px 700 uppercase in `stone-3`, not a title.
- **Body** (300–400, 11–13px, 1.5): verdicts, review text, answers. 11px in panels, 13px in the web lede and daylight summary, 15px only for the web hero lede. Prose blocks stop at 60ch.
- **Label** (500–600, 9–10px, 0.10–0.16em, uppercase): section introductions, chip counts, "Reading reviews…" states. In Plex Mono at 500 on the night skin; the popup's eyebrow goes to 0.16em.

### Named Rules
**The Tabular Rule.** Every count, percent, and score is `font-variant-numeric: tabular-nums` in Plex Mono (night) or the host sans with tabular-nums (daylight), right-aligned when it sits in a column.
**The No-Heading Rule.** Sections open with a micro-label. There are no h2s inside a panel.

## Layout

Panels are single columns. The Maps panel is a fixed 296px slab at the top right of the viewport with 18px padding; the Booking panel is a container-query island under the host's score with 16px 12px padding; the daylight island is a full-width card in the product column with 14px 16px padding; the web app is one centered column with 16px side gutters and safe-area padding.

Rhythm inside a panel runs on 4/6/8/12/16: 6px between a label and its figure, 8px between sibling controls and cards, 10px between the rows of a widget column, 12px between sections, 16–18px at the panel edge. Groups separate with a hairline (night) or a 1px dashed `paper-line` rule with 12px on each side (daylight) rather than with boxes. Scrollable review lists cap at 360px and scroll inside the panel; the summary panel caps at 60vh.

Density is high on purpose: a 296px panel holds a figure, a bar, chips, a search, and a summary. Micro-labels and hairlines, not white space, do the separating. The daylight island keeps the same density but breathes a little more (10px column gap) because it competes with the host's own copy.

Responsive behavior is structural, not fluid. The extension has no mobile surface. The web app stacks its rows and keeps every control full-width at phone widths; chips wrap.

## Elevation & Depth

Glass floats, paper lies flat. The night-glass panel carries one ambient shadow and a 1px inset top light that reads as the edge of a slab under a lamp; everything inside it is flat, layered by 3–8% white surfaces and hairlines. The daylight island has no shadow at all: a 1px `paper-line` border on `paper` over the host's white. Depth is never used to mark state. The only exceptions are the daylight button's hover, which gains a 1px offset 3px blur teal shadow, and the Maps bar fill's faint glow.

### Shadow Vocabulary
- **Panel ambient** (`box-shadow: 0 8px 40px rgba(0, 0, 0, 0.35), inset 0 1px 0 rgba(255, 255, 255, 0.06)`): the Maps panel. Booking uses the same recipe at `0 8px 32px rgba(0, 0, 0, 0.28)` with a 5% inset light.
- **Daylight button hover** (`box-shadow: 0 1px 3px rgba(15, 118, 110, 0.12)`): the only stateful shadow.
- **Bar glow** (`box-shadow: 0 0 8px rgba(200, 200, 160, 0.2)`): under the signature bar fill on Maps cards.

### Named Rules
**The Flat Inside Rule.** Nothing inside a panel casts a shadow. Cards, chips, inputs, and buttons are hairline-bordered surfaces.

## Shapes

Radii scale with the object's size and role: 2px on bars and rails, 6px on daylight controls and cards, 8px on night controls and the daylight island, 10–12px on cards and the summary panel, 14–16px on the floating panels, and full pills for chips and recent-question tags. Borders are always 1px. Dashed 1px `paper-line` rules mark section changes on the daylight island; solid hairlines do it on glass. Circles appear only as status dots (6px) and the scan spinner. There is no clipping, no skew, no diagonal geometry.

## Components

Instrument-grade and quiet. Controls are small, hairline-bordered, and mono-labelled when they carry numbers; nothing is bigger than the figure it serves.

### Buttons
- **Shape:** rounded field (8px) on glass, rounded control (6px) on paper.
- **Glass:** `control` ground, `control-line` border, `ink-3` Sora 11px 500 text, 8px padding. The re-summarize variant is a 30px square in Plex Mono.
- **Hover / Focus:** ground and border rise to `control-hover` / 14% white, text to `ink-2`; 0.2s. The re-summarize square rotates −90° over 0.4s on the signature ease.
- **Daylight:** `teal-wash` ground, `teal-line` border, `teal-ink` 12px 600 text, 7px 14px padding; hover deepens the wash and adds the 1px teal shadow. The caption-row re-summarize button is 10px 600 `stone-3` text on a `stone-4`-bordered 4px pill that turns teal on hover.
- **Signature (web app only):** the brass-to-sea-glass gradient at 135° as the one filled button, `night-ground` text in Plex Mono 11px 600 tracked 0.12em, no radius. This is the page's one signature.
- **Disabled:** 50% opacity, `cursor: wait`.

### Chips
- **Style:** pill, `control` ground, `control-line` border, Sora 11–12px `ink-1` label with a Plex Mono 10–11px tabular count or percent beside it.
- **State:** hover lifts ground to `control-hover` and border to 18–20% white; active swaps to `sea-glass-wash` ground with `sea-glass-line` border. A pending chip pulses its percent at `ink-3` with 0.06em tracking. Recent-question chips carry a `×` at `ink-4` that brightens to `ink-1`.

### Cards / Containers
- **Corner Style:** 12px on glass cards, 10px on the summary panel, 8px on the daylight island, 6px on daylight review and summary sections.
- **Background:** `card-glass` (3% white) on glass; `paper` for the island, `white` for review cards on it, the four washes for summary sections.
- **Shadow Strategy:** none inside panels (see Elevation).
- **Border:** 1px at 5% white on glass; 1px `paper-line` on paper.
- **Internal Padding:** 10px 12px on glass cards, 8px 10–12px on daylight sections and review cards, 12px in the summary panel.

### Inputs / Fields
- **Style:** `control` ground with `control-line` border on glass, `white` with `paper-line` on paper; 7px 10px padding; Sora 11px or the host sans 12px; placeholders at `ink-4` / `stone-4`. Key inputs in the popup are monospaced.
- **Focus:** border only: 20% white on glass, `teal-ink` on paper; 0.15–0.2s. No glow.
- **Error / Disabled:** status text turns `negative`; nothing else changes.

### Navigation
The extension has none. The popup is one column: a 2px signature hairline across the top of the page, a 16px 600 title tracked −0.02em, an 11px `ink-3` tagline, then 9px 600 uppercase eyebrows at 0.16em introducing each block. Segmented controls are hairline pills; the active segment fills with `sea-glass` and `night-ground` text.

### Score Figure and Bar
The signature component. A micro-label (9px 600 uppercase 0.12em `ink-3`) above a Plex Mono 600 figure (26px on cards, 56px on the web hero), a 2px `ink-5` track under it whose fill is the brass-to-sea-glass gradient and grows over 0.6s on the signature ease, and a Plex Mono count at `ink-3` beside it. On paper the same stack is a "% positive" gauge: a 13px `stone-2` label, a 3px-radius fill whose color comes from the HSL sentiment ramp, and 14px 700 tabular stats in `stone-ink`.

### Score Badge (result lists)
A compact `score (nps%)` span placed beside the host's own rating on every result card; tabular, colored by the sentiment ramp, never larger than the host's rating text. A best-ratio pick tints its card green and is reachable with `]` / `[`.

### Micro-label and Rule
Every section opens with a 9–10.5px uppercase label (Plex Mono 500 at 0.10–0.12em on glass; host sans 700 at 0.04–0.06em in `stone-2` or `stone-3` on paper) and is separated from the previous one by a hairline or a dashed `paper-line` rule with 12px on each side.

### Host-Mirroring Inline Panels
On Letterboxd, IMDb, and Goodreads the ledger wears the host's clothes: Letterboxd's slate grays (#9ab, #678, #456) and its green; IMDb's yellow (#f5c518) on its dark hero; Goodreads' brown (#382110) and beige with Lato and Merriweather. What stays TrueScore's: tabular figures, one micro-label per section, one verdict line, hairline separators, and no shadows.

## Do's and Don'ts

### Do:
- **Do** set every figure in IBM Plex Mono 500–600 with tabular numerals on glass, and with tabular numerals in the host sans on paper.
- **Do** open every section with an uppercase micro-label (9px 0.12em on glass, 10.5px 0.06em on paper) and separate sections with a hairline or a dashed `paper-line` rule, 12px each side.
- **Do** use the brass-to-sea-glass gradient exactly once per panel, as a hairline or a bar fill.
- **Do** choose ink by rank on the opacity ladder (`ink-1` to `ink-5`) or the stone ladder (`stone-ink` to `stone-4`).
- **Do** animate with `cubic-bezier(0.16, 1, 0.3, 1)` on glass and `cubic-bezier(0.25, 1, 0.5, 1)` on paper: 0.15–0.2s for state, 0.4–0.6s for bars and entrances.
- **Do** keep glass panels at `night-glass` with `blur(24px) saturate(180%)`, a `hairline` border, and one ambient shadow.
- **Do** match the host's palette and typeface on Letterboxd, IMDb, and Goodreads while keeping the ledger's grammar.

### Don't:
- **Don't** use purple-to-blue gradients or any gradient other than brass-to-sea-glass.
- **Don't** set gradient text; emphasis comes from weight, size, and the ink ladder.
- **Don't** use blur or glass as decoration; it is the panel's material only.
- **Don't** fill a button, chip, or card with a sentiment color; tint at 10–30% or color the figure.
- **Don't** put a shadow on anything inside a panel, or use a shadow to mark state beyond the daylight button's 1px hover.
- **Don't** introduce a heading inside a panel; the micro-label is the heading.
- **Don't** nest cards, or let the panel exceed its host's own rating in visual weight on a result list.
