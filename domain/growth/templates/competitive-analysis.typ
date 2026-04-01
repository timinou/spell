// Competitive Analysis — Spell report template.
// Reads from data.yaml when present; shows placeholder text otherwise.
#import "../branding/spell-brand/lib.typ": *

#let data = if sys.inputs.at("data", default: none) != none {
  yaml("data.yaml")
} else {
  (
    market: "[Market / Vertical]",
    date: none,
    market_overview: "[Provide a brief overview of the competitive landscape.]",
    competitors: (
      (
        name: "[Competitor A]",
        positioning: "[Positioning statement]",
        strengths: "[Key strengths]",
        weaknesses: "[Key weaknesses]",
        spend_estimate: "[Spend estimate]",
      ),
    ),
    ad_analysis: (
      (
        competitor: "[Competitor]",
        format: "[Format]",
        message: "[Core message]",
        platform: "[Platform]",
        observation: "[Observation]",
      ),
    ),
    strategic_implications: (
      "[Strategic implication 1]",
      "[Strategic implication 2]",
    ),
  )
}

// ── Page setup ────────────────────────────────────────────────────────────────
#report-page(
  "Competitive Analysis",
  subtitle: data.at("market", default: ""),
)

// ── Title ─────────────────────────────────────────────────────────────────────
#align(center)[
  #text(font: heading-font, size: h1-size, fill: spell-dark, weight: "bold")[
    Competitive Analysis
  ]
  #v(4pt)
  #text(font: body-font, size: body-size, fill: spell-gray-500)[
    #data.at("market", default: "[Market]")
    #if data.at("date", default: none) != none [ · #data.at("date")]
  ]
]

#v(20pt)

// ── Market Overview ───────────────────────────────────────────────────────────
#section-header("Market Overview")
#text(font: body-font, size: body-size, fill: spell-gray-800)[
  #data.at("market_overview", default: "[Market overview not provided.]")
]

#v(16pt)

// ── Competitor Grid ───────────────────────────────────────────────────────────
#section-header("Competitor Grid")

#let comps = data.at("competitors", default: ())
#if comps.len() > 0 [
  #table(
    columns: (2fr, 2fr, 2fr, 2fr, 1.5fr),
    fill: (col, row) => if row == 0 { spell-dark } else if calc.odd(row) { spell-gray-50 } else { white },
    stroke: 0.5pt + spell-gray-200,
    inset: 8pt,

    text(font: heading-font, size: small-size, fill: white, weight: "bold")[Competitor],
    text(font: heading-font, size: small-size, fill: white, weight: "bold")[Positioning],
    text(font: heading-font, size: small-size, fill: white, weight: "bold")[Strengths],
    text(font: heading-font, size: small-size, fill: white, weight: "bold")[Weaknesses],
    text(font: heading-font, size: small-size, fill: white, weight: "bold")[Est. Spend],

    ..comps.map(c => (
      text(font: heading-font, size: small-size, fill: spell-dark, weight: "semibold")[
        #c.at("name", default: "—")
      ],
      text(font: body-font, size: small-size, fill: spell-gray-700)[
        #c.at("positioning", default: "—")
      ],
      text(font: body-font, size: small-size, fill: spell-success)[
        #c.at("strengths", default: "—")
      ],
      text(font: body-font, size: small-size, fill: spell-error)[
        #c.at("weaknesses", default: "—")
      ],
      text(font: body-font, size: small-size, fill: spell-gray-600)[
        #c.at("spend_estimate", default: "—")
      ],
    )).flatten(),
  )
] else [
  #callout-box("No competitor data provided.", type: "info")
]

#v(16pt)

// ── Ad Analysis ───────────────────────────────────────────────────────────────
#section-header("Ad Analysis")

#let ads = data.at("ad_analysis", default: ())
#if ads.len() > 0 [
  #table(
    columns: (1.5fr, 1fr, 3fr, 1fr, 3fr),
    fill: (col, row) => if row == 0 { spell-dark } else if calc.odd(row) { spell-gray-50 } else { white },
    stroke: 0.5pt + spell-gray-200,
    inset: 8pt,

    text(font: heading-font, size: small-size, fill: white, weight: "bold")[Competitor],
    text(font: heading-font, size: small-size, fill: white, weight: "bold")[Format],
    text(font: heading-font, size: small-size, fill: white, weight: "bold")[Core Message],
    text(font: heading-font, size: small-size, fill: white, weight: "bold")[Platform],
    text(font: heading-font, size: small-size, fill: white, weight: "bold")[Observation],

    ..ads.map(a => (
      text(font: body-font, size: small-size)[#a.at("competitor", default: "—")],
      text(font: body-font, size: small-size, fill: spell-purple)[#a.at("format", default: "—")],
      text(font: body-font, size: small-size)[#a.at("message", default: "—")],
      text(font: body-font, size: small-size)[#a.at("platform", default: "—")],
      text(font: body-font, size: small-size, fill: spell-gray-600)[#a.at("observation", default: "")],
    )).flatten(),
  )
] else [
  #callout-box("No ad analysis data provided.", type: "info")
]

#v(16pt)

// ── Strategic Implications ────────────────────────────────────────────────────
#section-header("Strategic Implications")

#let implications = data.at("strategic_implications", default: ())
#if implications.len() > 0 [
  #for impl in implications [
    #callout-box(impl, type: "info")
  ]
] else [
  #text(font: body-font, size: body-size, fill: spell-gray-500)[
    [No strategic implications recorded.]
  ]
]
