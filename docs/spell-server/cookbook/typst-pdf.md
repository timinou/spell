# Generating PDFs with Typst

This guide shows how to wire up a Telegram session-notification renderer that converts session transcripts to styled PDF documents using Typst and cmarker.

## Prerequisites

You need Typst installed. Here are one-liners for common OSes:

**macOS** (Homebrew):
```bash
brew install typst
```

**Linux** (Fedora/RHEL):
```bash
sudo dnf install typst
```

**Linux** (Debian/Ubuntu):
```bash
sudo apt-get install typst
```

**Linux** (Arch):
```bash
sudo pacman -S typst
```

**Windows** (Chocolatey):
```bash
choco install typst
```

If these don't work, download a pre-built binary from [typst.app](https://typst.app) or build from source at [github.com/typst/typst](https://github.com/typst/typst).

## The Render Script

Create `render/typst-render.sh` in your project:

```bash
#!/usr/bin/env bash
# Renderer contract: stdin = markdown, stdout = PDF bytes.
# This is the exact shape the proposed `renderer { command ... }` KDL block expects.
#
# Optional metadata is forwarded to the typst template via --input.
#   SPELL_RENDER_TITLE      → cover title
#   SPELL_RENDER_STATUS     → status badge (default needs_input)
#   SPELL_RENDER_PROJECT    → project label
#   SPELL_RENDER_MESSAGES   → message count
#
# Usage (smoke):
#   echo "# hello" | bash render/typst-render.sh > out.pdf
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

cat > "$tmp/transcript.md"
cp "$here/template.typ" "$tmp/main.typ"

declare -a inputs=()
[ -n "${SPELL_RENDER_TITLE:-}"    ] && inputs+=(--input "title=$SPELL_RENDER_TITLE")
[ -n "${SPELL_RENDER_STATUS:-}"   ] && inputs+=(--input "status=$SPELL_RENDER_STATUS")
[ -n "${SPELL_RENDER_PROJECT:-}"  ] && inputs+=(--input "project=$SPELL_RENDER_PROJECT")
[ -n "${SPELL_RENDER_MESSAGES:-}" ] && inputs+=(--input "messages=$SPELL_RENDER_MESSAGES")

typst compile --root "$tmp" "${inputs[@]}" "$tmp/main.typ" - --format pdf
```

Make it executable:

```bash
chmod +x render/typst-render.sh
```

## The Typst Template

Create `render/template.typ`:

```typst
// Typst template: a clean, magazine-style transcript with role-colored bars,
// monospaced tool blocks, a header strip, and footer page numbering.
// First-run will fetch @preview/cmarker from the Typst Universe registry.

#import "@preview/cmarker:0.1.6": render as cmarker

// ─── palette ───
#let palette = (
  bg-card:   rgb("#fafbfc"),
  border:    rgb("#e6e8eb"),
  ink:       rgb("#1a1a1a"),
  mute:      rgb("#6b7077"),
  accent:    rgb("#0a66c2"),
  user:      rgb("#0a66c2"),
  assistant: rgb("#3e8a3a"),
  tool:      rgb("#9a6bdc"),
  code-bg:   rgb("#f4f4f6"),
  code-edge: rgb("#dcdfe3"),
)

// ─── page setup ───
#set page(
  paper: "a4",
  margin: (x: 1.7cm, top: 2.1cm, bottom: 1.9cm),
  numbering: "1 / 1",
  header: align(right)[
    #text(size: 8.5pt, fill: palette.mute)[
      Spell transcript · newest-first · #datetime.today().display()
    ]
  ],
  footer: context align(center)[
    #text(size: 8.5pt, fill: palette.mute)[
      page #counter(page).display() of #counter(page).final().first()
    ]
  ],
)

// ─── typography ───
#set text(
  font: ("Inter", "DejaVu Sans"),
  size: 10pt,
  fill: palette.ink,
)
#set par(leading: 0.62em, justify: false, linebreaks: "optimized")

// h2 = role header line. cmarker emits `## role · #N — latest`.
// We restyle it into a coloured pill so each turn is visually segmented.
#show heading.where(level: 2): it => {
  let label = it.body
  let txt = repr(label).slice(1, -1) // unwrap "..."
  let role-color = if txt.contains("user") { palette.user }
                   else if txt.contains("assistant") { palette.assistant }
                   else { palette.tool }
  v(0.9em)
  block(
    breakable: false,
    width: 100%,
    inset: (top: 6pt, bottom: 6pt, x: 10pt),
    radius: 4pt,
    fill: role-color.lighten(85%),
    stroke: (left: 3pt + role-color),
  )[
    #text(weight: "bold", size: 11pt, fill: role-color)[#label]
  ]
  v(0.3em)
}

#show heading.where(level: 1): it => block(spacing: 1.1em)[
  #text(weight: "bold", size: 16pt, it.body)
]
#show heading.where(level: 3): it => block(spacing: 0.7em)[
  #text(weight: "bold", size: 12pt, fill: palette.mute, it.body)
]

#show raw.where(block: true): it => block(
  fill: palette.code-bg,
  stroke: 0.6pt + palette.code-edge,
  inset: 8pt,
  radius: 3pt,
  width: 100%,
  breakable: true,
  text(font: ("JetBrains Mono", "DejaVu Sans Mono"), size: 8.4pt, it),
)
#show raw.where(block: false): it => box(
  fill: palette.code-bg,
  inset: (x: 3pt, y: 1pt),
  outset: (y: 1pt),
  radius: 2pt,
  text(font: ("JetBrains Mono", "DejaVu Sans Mono"), size: 9pt, it),
)
#show link: it => text(fill: palette.accent, underline(it))
#show quote: it => block(
  inset: (left: 10pt, top: 2pt, bottom: 2pt),
  stroke: (left: 2pt + palette.mute),
  text(fill: palette.mute, style: "italic", it),
)
// Render `> **tool** \`...\`` lines (cmarker turns them into blockquotes)
// with a tighter tone so they read as call-out chrome, not content.
#show "tool result": it => text(font: ("JetBrains Mono",), fill: palette.tool, weight: "bold", it)
#show "tool": it => text(weight: "bold", fill: palette.tool, it)

// horizontal rule → soft divider with breath above/below
#show line: it => v(0.9em) + it + v(0.4em)

// ─── cover card ───
#let session-meta = (
  title: sys.inputs.at("title", default: "Spell session transcript"),
  status: sys.inputs.at("status", default: "needs_input"),
  project: sys.inputs.at("project", default: ""),
  message-count: sys.inputs.at("messages", default: ""),
)

#block(
  fill: palette.bg-card,
  stroke: 0.6pt + palette.border,
  radius: 6pt,
  inset: 18pt,
  width: 100%,
)[
  #grid(
    columns: (auto, 1fr),
    gutter: 12pt,
    [
      #text(size: 22pt, weight: "bold")[Spell]
      #v(-4pt)
      #text(size: 10pt, fill: palette.mute)[session transcript]
    ],
    align(right)[
      #text(size: 9pt, fill: palette.mute, weight: "medium", upper(session-meta.status))
      #v(-4pt)
      #text(size: 14pt, weight: "bold")[#session-meta.title]
      #if session-meta.project != "" [
        #v(-2pt)
        #text(size: 9pt, fill: palette.mute)[project: #raw(session-meta.project)]
      ]
      #if session-meta.message-count != "" [
        #v(-2pt)
        #text(size: 9pt, fill: palette.mute)[#session-meta.message-count messages · newest-first]
      ]
    ],
  )
]
#v(0.9em)

// ─── transcript body ───
#cmarker(read("transcript.md"))
```

## The KDL `renderer` block

In `.spell/channels.kdl`, declare a named renderer pointing to your script:

```kdl
telegram {
  bot-token-file ".spell/bot-token"
  owners 123456789
  default-model "claude-sonnet-4-5"
  upload-dir "/tmp/spell-telegram-uploads"

  renderer "typst-pdf" {
    command "bash render/typst-render.sh"
    mime "application/pdf"
    extension "pdf"
    timeout-ms 30000
    cache-by "hash"
  }

  session-notifications {
    events "needs_input"
    attach renderer="typst-pdf" {
      transcript "latest 50"
      on "needs_input"
      summarize {
        style "bullet"
        max-tokens 500
      }
    }
  }
}
```

## Debugging the Renderer

When the KDL is parsed and a notification fires, Spell will call your renderer subprocess with:

- stdin = markdown transcript content
- stdout = PDF bytes

To debug locally, fake a markdown input and run the renderer directly:

```bash
export SPELL_RENDER_TITLE="Debug Run"
export SPELL_RENDER_STATUS="testing"
echo "# Testing Typst

This is a **test** with some \`code\`.

## Turn 1

Sample content here." | bash render/typst-render.sh > /tmp/output.pdf
```

The renderer writes directly to stdout, so you can pipe it to a file and open it in any PDF viewer. Adjust the environment variables (`SPELL_RENDER_TITLE`, `SPELL_RENDER_STATUS`, `SPELL_RENDER_PROJECT`, `SPELL_RENDER_MESSAGES`) to test different cover layouts.
