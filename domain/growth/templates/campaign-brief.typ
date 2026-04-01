// Campaign Brief — Spell report template.
// Reads from data.yaml when present; shows placeholder text otherwise.
#import "../branding/spell-brand/lib.typ": *

#let data = if sys.inputs.at("data", default: none) != none {
  yaml("data.yaml")
} else {
  (
    campaign_name: "[Campaign Name]",
    date: none,
    objective: "[State the primary campaign objective and success metric.]",
    target_audience: (
      demographics: "[Age, gender, income, location]",
      psychographics: "[Interests, values, pain points]",
      segments: ("[Segment A]", "[Segment B]"),
    ),
    channels: (
      (name: "[Channel]", budget_pct: 0, notes: "[Notes]"),
    ),
    budget: (
      total: "$0",
      breakdown: (
        (line: "Paid Social", amount: "$0"),
        (line: "Search", amount: "$0"),
        (line: "Creative Production", amount: "$0"),
      ),
    ),
    timeline: (
      (phase: "Pre-launch", dates: "[Dates]", tasks: "[Tasks]"),
      (phase: "Launch", dates: "[Dates]", tasks: "[Tasks]"),
      (phase: "Optimization", dates: "[Dates]", tasks: "[Tasks]"),
      (phase: "Reporting", dates: "[Dates]", tasks: "[Tasks]"),
    ),
    creative_direction: "[Describe visual style, tone of voice, key messages, and any brand constraints.]",
  )
}

// ── Page setup ────────────────────────────────────────────────────────────────
#report-page(
  "Campaign Brief",
  subtitle: data.at("campaign_name", default: ""),
)

// ── Title ─────────────────────────────────────────────────────────────────────
#align(center)[
  #text(font: heading-font, size: h1-size, fill: spell-dark, weight: "bold")[
    Campaign Brief
  ]
  #v(4pt)
  #text(font: body-font, size: body-size, fill: spell-gray-500)[
    #data.at("campaign_name", default: "[Campaign Name]")
    #if data.at("date", default: none) != none [ · #data.at("date")]
  ]
]

#v(20pt)

// ── Objective ─────────────────────────────────────────────────────────────────
#section-header("Objective")
#callout-box(data.at("objective", default: "[Objective not set.]"), type: "info")

#v(8pt)

// ── Target Audience ───────────────────────────────────────────────────────────
#section-header("Target Audience")

#let audience = data.at("target_audience", default: (:))
#grid(
  columns: (1fr, 1fr),
  gutter: 12pt,
  block(
    fill: spell-gray-50,
    stroke: 0.5pt + spell-gray-200,
    radius: 4pt,
    inset: 12pt,
    [
      #text(font: heading-font, size: small-size, fill: spell-purple, weight: "bold")[Demographics]
      #v(6pt)
      #text(font: body-font, size: body-size, fill: spell-gray-800)[
        #audience.at("demographics", default: "[Not specified]")
      ]
    ],
  ),
  block(
    fill: spell-gray-50,
    stroke: 0.5pt + spell-gray-200,
    radius: 4pt,
    inset: 12pt,
    [
      #text(font: heading-font, size: small-size, fill: spell-purple, weight: "bold")[Psychographics]
      #v(6pt)
      #text(font: body-font, size: body-size, fill: spell-gray-800)[
        #audience.at("psychographics", default: "[Not specified]")
      ]
    ],
  ),
)

#v(8pt)
#let segments = audience.at("segments", default: ())
#if segments.len() > 0 [
  #text(font: heading-font, size: small-size, fill: spell-gray-600, weight: "semibold")[Key Segments: ]
  #text(font: body-font, size: small-size, fill: spell-gray-700)[#segments.join(" · ")]
]

#v(16pt)

// ── Channels ──────────────────────────────────────────────────────────────────
#section-header("Channels")

#let channels = data.at("channels", default: ())
#if channels.len() > 0 [
  #table(
    columns: (2fr, 1fr, 4fr),
    fill: (col, row) => if row == 0 { spell-dark } else if calc.odd(row) { spell-gray-50 } else { white },
    stroke: 0.5pt + spell-gray-200,
    inset: 8pt,

    text(font: heading-font, size: small-size, fill: white, weight: "bold")[Channel],
    text(font: heading-font, size: small-size, fill: white, weight: "bold")[Budget %],
    text(font: heading-font, size: small-size, fill: white, weight: "bold")[Notes],

    ..channels.map(ch => (
      text(font: body-font, size: body-size)[#ch.at("name", default: "—")],
      text(font: body-font, size: body-size, fill: spell-purple)[
        #ch.at("budget_pct", default: 0)%
      ],
      text(font: body-font, size: body-size, fill: spell-gray-600)[
        #ch.at("notes", default: "")
      ],
    )).flatten(),
  )
]

#v(16pt)

// ── Budget Breakdown ──────────────────────────────────────────────────────────
#section-header("Budget Breakdown")

#let budget-data = data.at("budget", default: (:))
#let breakdown = budget-data.at("breakdown", default: ())
#let total = budget-data.at("total", default: "—")

#if breakdown.len() > 0 [
  #table(
    columns: (3fr, 1fr),
    fill: (col, row) => if row == 0 { spell-dark } else if calc.odd(row) { spell-gray-50 } else { white },
    stroke: 0.5pt + spell-gray-200,
    inset: 8pt,

    text(font: heading-font, size: small-size, fill: white, weight: "bold")[Line Item],
    text(font: heading-font, size: small-size, fill: white, weight: "bold")[Amount],

    ..breakdown.map(b => (
      text(font: body-font, size: body-size)[#b.at("line", default: "—")],
      text(font: body-font, size: body-size)[#b.at("amount", default: "—")],
    )).flatten(),

    text(font: heading-font, size: body-size, fill: spell-dark, weight: "bold")[Total],
    text(font: heading-font, size: body-size, fill: spell-purple, weight: "bold")[#total],
  )
]

#v(16pt)

// ── Timeline ──────────────────────────────────────────────────────────────────
#section-header("Timeline")

#let phases = data.at("timeline", default: ())
#if phases.len() > 0 [
  #for phase in phases [
    #grid(
      columns: (1.5fr, 1.5fr, 4fr),
      gutter: 8pt,
      block(
        fill: spell-purple,
        radius: 4pt,
        inset: (x: 8pt, y: 6pt),
        text(font: heading-font, size: small-size, fill: white, weight: "bold")[
          #phase.at("phase", default: "Phase")
        ],
      ),
      text(font: body-font, size: small-size, fill: spell-gray-500)[
        #phase.at("dates", default: "")
      ],
      text(font: body-font, size: small-size, fill: spell-gray-800)[
        #phase.at("tasks", default: "")
      ],
    )
    #v(4pt)
  ]
]

#v(16pt)

// ── Creative Direction ────────────────────────────────────────────────────────
#section-header("Creative Direction")
#text(font: body-font, size: body-size, fill: spell-gray-800)[
  #data.at("creative_direction", default: "[Creative direction not provided.]")
]
