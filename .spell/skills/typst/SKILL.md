---
name: typst
description: Write and compile excellent Typst documents — brand-aware, component-driven, data-hydrated
globs: ["**/*.typ"]
---

# Typst

Use this skill whenever the task touches `.typ` files or PDF deliverables: proposals, technical reports, research briefs, slide decks, branded collateral, or reusable Typst libraries.

## When to use

Reach for this skill when you need to:
- create or edit a Typst document or template
- structure a professional PDF, not an app UI
- build reusable document components with `#let`
- apply a local brand library or design system
- hydrate a document from YAML or JSON inputs
- compile a `.typ` file to PDF and send the result to the user

## Repo patterns to copy first

Observed patterns in this workspace:
- `domain/growth/branding/spell-brand/lib.typ` is the aggregation entrypoint for colors, typography, components, and layout
- `domain/growth/templates/*.typ` uses `sys.inputs` plus `yaml()` to hydrate branded reports and proposals
- `/home/user/code/backdesk/.local/pitch-deck.typ` uses wide pages, strong visual hierarchy, reusable cards, gradients, and placed decorative shapes for decks
- `/home/user/code/ora/sothema/rapport-technique.typ` uses native Typst primitives for polished A4 technical reports
- `/home/user/code/ora/growth/morocco_tech_ecosystem_report.typ` uses numbered headings, outline generation, and package imports for research-style documents

Default behavior: copy the existing local pattern instead of inventing a new Typst style.

## Typst fundamentals

### Modes
- Markup mode is the default document surface.
- Code mode starts with `#`.
- Math mode starts with `$`.

```typst
#set text(font: "Inter", size: 11pt)

This is markup.

#let total = 42
The total is #total.

$ a^2 + b^2 = c^2 $
```

### Bindings and functions

Use `#let` for both values and reusable components.

```typst
#let accent = rgb("#7C3AED")
#let title = "Spell"

#let stat(value, label) = block(
  inset: 12pt,
  radius: 8pt,
  fill: rgb("#F5F3FF"),
)[
  #text(size: 20pt, weight: "bold", fill: accent)[#value]
  #v(4pt)
  #text(size: 10pt)[#label]
]
```

Prefer named optional parameters with defaults.

```typst
#let callout(title, body, fill: rgb("#F8FAFC"), stroke: rgb("#CBD5E1")) = block(
  fill: fill,
  stroke: 1pt + stroke,
  radius: 8pt,
  inset: 12pt,
)[
  #text(weight: "bold")[#title]
  #v(6pt)
  #body
]
```

### Imports

```typst
#import "../branding/spell-brand/lib.typ": *
#import "./components.typ": stat, callout
#import "@preview/tablex:0.0.8": tablex
```

Use the narrowest import that keeps the file readable.

### Set rules

Set document-wide defaults near the top of the file.

```typst
#set document(title: "Client Proposal", author: "Spell")
#set page(paper: "a4", margin: (x: 2.5cm, y: 2.5cm), numbering: "1")
#set text(font: ("Inter", "Helvetica Neue", "Arial"), size: 11pt, fill: rgb("#0F172A"))
#set par(justify: true, leading: 0.8em)
```

### Show rules

Use show rules for styling by selector or for structural transforms.

```typst
#show heading: set text(weight: "bold")
#show heading.where(level: 1): set text(fill: rgb("#7C3AED"), size: 20pt)
```

For custom heading rendering, transform with a function.

```typst
#show heading.where(level: 1): it => [
  #text(weight: "bold", fill: rgb("#7C3AED"))[#it.body]
  #v(4pt)
  #line(length: 100%, stroke: 1.5pt + rgb("#7C3AED"))
]
```

### Flow control and content blocks

```typst
#let items = ("Research", "Strategy", "Reporting")

#if items.len() > 0 [
  #for item in items [
    - #item
  ]
]
```

Use content blocks for anything that should render as document content.

```typst
#block(fill: rgb("#F8FAFC"), inset: 12pt)[
  This is a boxed content block.
]
```

### Common layout primitives

Use Typst primitives directly before adding abstraction.

```typst
#grid(
  columns: (1fr, 1fr),
  gutter: 12pt,
  stat("12", "Customers"),
  stat("94%", "Retention"),
)

#stack(
  spacing: 8pt,
  [First block],
  [Second block],
)

#align(center)[#text(size: 24pt, weight: "bold")[Centered Title]]
```

Commonly useful functions:
- `text()`
- `grid()`
- `table()`
- `block()`
- `box()`
- `stack()`
- `align()`
- `pad()`
- `place()`
- `image()`
- `line()`
- `circle()`
- `rect()`
- `ellipse()`

### Data access

Prefer explicit records and safe `.at()` access.

```typst
#let data = (
  client: "Example Co.",
  deliverables: ((item: "Audit"), (item: "Strategy")),
)

#let client = data.at("client", default: "[Client Name]")
#let deliverables = data.at("deliverables", default: ())

#for deliverable in deliverables [
  - #deliverable.at("item", default: "—")
]
```

Useful collection methods:
- `.map()`
- `.filter()`
- `.join()`
- `.flatten()`

### Spacing, color, and metadata

```typst
#let brand-primary = rgb("#7C3AED")
#let brand-soft = brand-primary.lighten(80%)

#v(12pt)
#h(6pt)

#set document(title: "Research Report", author: "Spell")
```

Prefer consistent spacing increments such as `4pt`, `8pt`, `12pt`, `16pt`, `24pt`.

## Component design patterns

### Reusable components

Turn repeated layout into a function, not copy-paste.

```typst
#let section-header(title) = {
  v(16pt)
  text(size: 16pt, weight: "bold")[#title]
  v(4pt)
  line(length: 100%, stroke: 1pt + rgb("#7C3AED"))
  v(10pt)
}
```

### Table pattern

Use styled header rows and readable widths.

```typst
#table(
  columns: (2fr, 3fr),
  inset: 8pt,
  stroke: 0.5pt + rgb("#CBD5E1"),
  fill: (x, y) => if y == 0 { rgb("#0F172A") } else if calc.odd(y) { rgb("#F8FAFC") } else { white },
  text(weight: "bold", fill: white)[Item],
  text(weight: "bold", fill: white)[Notes],
  [Audit], [Current-state review],
  [Roadmap], [Execution plan],
)
```

### Card and box pattern

```typst
#let card(title, body) = box(
  inset: 16pt,
  radius: 10pt,
  fill: rgb("#111827"),
  stroke: 1pt + rgb("#374151"),
)[
  #text(weight: "bold", fill: white)[#title]
  #v(8pt)
  #text(fill: rgb("#D1D5DB"))[#body]
]
```

### Slide/deck pattern

Pitch decks in this workspace use wide pages, visual accents, and sparse text.

```typst
#set page(width: 1280pt, height: 720pt, margin: 0pt)
#let bg-dark = rgb("#1C1E26")
#let crimson = rgb("#E95678")
#let coral = rgb("#F09383")

#page(fill: bg-dark)[
  #place(top + right, dx: 80pt, dy: -120pt,
    circle(radius: 220pt, fill: gradient.radial(
      (crimson, 0%),
      (coral.transparentize(70%), 40%),
      (bg-dark.transparentize(100%), 100%),
    )))
  #align(center + horizon)[
    #text(size: 42pt, weight: "bold", fill: white)[Main message]
    #v(12pt)
    #text(size: 18pt, fill: rgb("#B0A8A3"))[One supporting sentence]
  ]
]
```

## Brand library pattern

For branded work, use the local library first.

1. Find the project brand entrypoint, usually `branding/<brand>/lib.typ`.
2. Import the entrypoint, not individual raw values, unless the local pattern already imports leaf files directly.
3. Use named colors, named fonts, and brand components.
4. If the brand lacks a token you need, add it to the brand library instead of hardcoding a one-off value inside the document.

```typst
#import "../branding/spell-brand/lib.typ": *

#report-page("Client Proposal", subtitle: "Growth Strategy")
#section-header("Executive Summary")
#text(font: body-font, size: body-size, fill: spell-gray-800)[
  Brand-aligned body copy.
]
```

Rules:
- prefer `body-font`, `heading-font`, `spell-purple`, `spell-dark`, etc. over literal values
- prefer existing brand components such as `cover-page`, `section-header`, `report-page`
- never drift off palette in a branded deliverable

## Data-driven template pattern

Templates in this repo keep placeholder content in-source and hydrate from external data when provided.

```typst
#let data = if sys.inputs.at("data", default: none) != none {
  yaml("data.yaml")
} else {
  (
    client: "[Client Name]",
    subtitle: "[Subtitle]",
    deliverables: (),
  )
}

#let client = data.at("client", default: "[Client Name]")
```

Use this for proposals, briefs, weekly digests, and report generators.

## Document recipes

### Proposal or client report
- A4 page
- brand cover page
- section headers
- tables for deliverables, budget, timeline
- concise callouts for recommendations

### Slide deck
- wide page (`1280pt x 720pt` or another 16:9 size)
- one page per slide
- sparse text
- reusable cards/stat blocks
- gradients or shapes only when they support hierarchy

### Academic or research report
- numbered headings via `#set heading(numbering: "1.")`
- `#outline()` for table of contents
- consistent tables and citations
- restrained styling over decorative density

## Compilation workflow

Use the existing shell workflow. Do not add a new Typst wrapper tool.

```bash
typst compile input.typ output.pdf
typst compile --font-path ./fonts input.typ output.pdf
typst compile --input data=data.yaml input.typ output.pdf
```

Recommended loop:
1. edit the `.typ` source
2. compile immediately after each meaningful layout change
3. inspect the PDF, not just the source
4. fix overflow, spacing, hierarchy, and orphaned pages
5. send the PDF to the user with `send_file`

Example post-compile step:

```text
send_file path="output.pdf"
```

## Quality checklist

Before you finish a Typst task, verify:
- the document compiles cleanly
- imports resolve from the file’s actual location
- the brand library is used when branded output is expected
- colors and fonts come from named brand tokens when available
- spacing uses consistent increments
- tables have readable widths and styled headers
- repeated structures are functions, not duplicated blocks
- data access uses `.at(..., default: ...)`
- no accidental placeholder text remains in final deliverables
- the PDF reads well visually, not only syntactically

## Default decision rule

If unsure, do this:
- import the local `lib.typ`
- keep data external and typed as explicit records
- build small reusable `#let` components
- use native Typst primitives before extra packages
- compile early, inspect often
