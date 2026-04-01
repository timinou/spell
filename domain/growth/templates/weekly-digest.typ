// Weekly Growth Digest — Spell report template.
// Reads from data.yaml when present; shows placeholder text otherwise.
#import "../branding/spell-brand/lib.typ": *

// ── Attempt to load data; gracefully fall back to placeholder struct ──────────
#let data = if sys.inputs.at("data", default: none) != none {
  yaml("data.yaml")
} else {
  (
    date_range: "Week of [date]",
    metrics: (
      (label: "Total Spend", value: "$0", delta: "+0%"),
      (label: "Impressions", value: "0", delta: "+0%"),
      (label: "Clicks", value: "0", delta: "+0%"),
      (label: "Conversions", value: "0", delta: "+0%"),
    ),
    competitors: (
      (name: "[Competitor]", activity: "[Activity]", platform: "[Platform]", notes: "[Notes]"),
    ),
    recommendations: (
      "[Recommendation 1]",
      "[Recommendation 2]",
    ),
  )
}

// ── Page setup ────────────────────────────────────────────────────────────────
#report-page("Weekly Growth Digest", subtitle: data.at("date_range", default: ""))

// ── Date range header ─────────────────────────────────────────────────────────
#align(center)[
  #text(font: heading-font, size: h1-size, fill: spell-dark, weight: "bold")[
    Weekly Growth Digest
  ]
  #v(4pt)
  #text(font: body-font, size: body-size, fill: spell-gray-500)[
    #data.at("date_range", default: "Week of [date]")
  ]
]

#v(20pt)

// ── Key metrics strip ─────────────────────────────────────────────────────────
#section-header("Key Metrics")
#metric-strip(data.at("metrics", default: ()))

#v(16pt)

// ── Competitor activity ───────────────────────────────────────────────────────
#section-header("Competitor Activity")

#let comps = data.at("competitors", default: ())
#if comps.len() > 0 [
  #table(
    columns: (2fr, 3fr, 1.5fr, 3fr),
    fill: (col, row) => if row == 0 { spell-dark } else if calc.odd(row) { spell-gray-50 } else { white },
    stroke: 0.5pt + spell-gray-200,
    inset: 8pt,

    // Header row
    text(font: heading-font, size: small-size, fill: white, weight: "bold")[Competitor],
    text(font: heading-font, size: small-size, fill: white, weight: "bold")[Activity],
    text(font: heading-font, size: small-size, fill: white, weight: "bold")[Platform],
    text(font: heading-font, size: small-size, fill: white, weight: "bold")[Notes],

    // Data rows
    ..comps.map(c => (
      text(font: body-font, size: body-size)[#c.at("name", default: "—")],
      text(font: body-font, size: body-size)[#c.at("activity", default: "—")],
      text(font: body-font, size: body-size)[#c.at("platform", default: "—")],
      text(font: body-font, size: body-size, fill: spell-gray-600)[#c.at("notes", default: "")],
    )).flatten(),
  )
] else [
  #callout-box("No competitor activity data available for this period.", type: "info")
]

#v(16pt)

// ── Recommendations ───────────────────────────────────────────────────────────
#section-header("Recommendations")

#let recs = data.at("recommendations", default: ())
#if recs.len() > 0 [
  #for (i, rec) in recs.enumerate() [
    #grid(
      columns: (20pt, 1fr),
      gutter: 8pt,
      align(center + top,
        block(
          fill: spell-purple,
          radius: 10pt,
          width: 20pt,
          height: 20pt,
          inset: 3pt,
          align(center + horizon,
            text(font: heading-font, size: small-size, fill: white, weight: "bold")[#(i + 1)],
          ),
        ),
      ),
      text(font: body-font, size: body-size, fill: spell-gray-800)[#rec],
    )
    #v(6pt)
  ]
] else [
  #callout-box("No recommendations recorded this week.", type: "info")
]
