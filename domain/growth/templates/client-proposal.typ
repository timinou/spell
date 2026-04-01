// Client Proposal — Spell report template.
// Reads from data.yaml when present; shows placeholder text otherwise.
#import "../branding/spell-brand/lib.typ": *

#let data = if sys.inputs.at("data", default: none) != none {
  yaml("data.yaml")
} else {
  (
    client: "[Client Name]",
    date: none,
    subtitle: "Growth Strategy Proposal",
    problem: "[Describe the client's core problem or opportunity here.]",
    approach: "[Outline the proposed approach and methodology.]",
    deliverables: (
      (item: "[Deliverable 1]", timeline: "[Week 1]", notes: ""),
      (item: "[Deliverable 2]", timeline: "[Week 2]", notes: ""),
    ),
    timeline_weeks: 4,
    budget: (
      (line: "Strategy & Research", amount: "$0"),
      (line: "Execution", amount: "$0"),
      (line: "Reporting", amount: "$0"),
    ),
    total_budget: "$0",
  )
}

// ── Cover page ────────────────────────────────────────────────────────────────
#cover-page(
  data.at("client", default: "[Client Name]"),
  subtitle: data.at("subtitle", default: "Growth Strategy Proposal"),
  date: data.at("date", default: none),
)

// ── Report page setup ─────────────────────────────────────────────────────────
#report-page(
  "Client Proposal",
  subtitle: data.at("client", default: ""),
)

// ── Problem Statement ─────────────────────────────────────────────────────────
#section-header("Problem Statement")
#text(font: body-font, size: body-size, fill: spell-gray-800)[
  #data.at("problem", default: "[Problem statement not provided.]")
]

#v(16pt)

// ── Our Approach ──────────────────────────────────────────────────────────────
#section-header("Our Approach")
#text(font: body-font, size: body-size, fill: spell-gray-800)[
  #data.at("approach", default: "[Approach not provided.]")
]

#v(16pt)

// ── Deliverables ──────────────────────────────────────────────────────────────
#section-header("Deliverables")

#let deliverables = data.at("deliverables", default: ())
#if deliverables.len() > 0 [
  #table(
    columns: (3fr, 1.5fr, 3fr),
    fill: (col, row) => if row == 0 { spell-dark } else if calc.odd(row) { spell-gray-50 } else { white },
    stroke: 0.5pt + spell-gray-200,
    inset: 8pt,

    text(font: heading-font, size: small-size, fill: white, weight: "bold")[Deliverable],
    text(font: heading-font, size: small-size, fill: white, weight: "bold")[Timeline],
    text(font: heading-font, size: small-size, fill: white, weight: "bold")[Notes],

    ..deliverables.map(d => (
      text(font: body-font, size: body-size)[#d.at("item", default: "—")],
      text(font: body-font, size: body-size, fill: spell-purple)[#d.at("timeline", default: "—")],
      text(font: body-font, size: body-size, fill: spell-gray-600)[#d.at("notes", default: "")],
    )).flatten(),
  )
]

#v(16pt)

// ── Timeline ──────────────────────────────────────────────────────────────────
#section-header("Timeline")

#let weeks = data.at("timeline_weeks", default: 4)
#grid(
  columns: weeks,
  gutter: 6pt,
  ..range(1, weeks + 1).map(w =>
    block(
      fill: if w == 1 { spell-purple } else { spell-gray-100 },
      stroke: 0.5pt + spell-gray-200,
      radius: 4pt,
      inset: 8pt,
      align(center, text(
        font: body-font,
        size: small-size,
        fill: if w == 1 { white } else { spell-gray-700 },
        weight: "semibold",
      )[Week #w]),
    )
  ),
)

#v(16pt)

// ── Budget ────────────────────────────────────────────────────────────────────
#section-header("Budget")

#let budget = data.at("budget", default: ())
#if budget.len() > 0 [
  #table(
    columns: (3fr, 1fr),
    fill: (col, row) => if row == 0 { spell-dark } else if calc.odd(row) { spell-gray-50 } else { white },
    stroke: 0.5pt + spell-gray-200,
    inset: 8pt,

    text(font: heading-font, size: small-size, fill: white, weight: "bold")[Line Item],
    text(font: heading-font, size: small-size, fill: white, weight: "bold")[Amount],

    ..budget.map(b => (
      text(font: body-font, size: body-size)[#b.at("line", default: "—")],
      text(font: body-font, size: body-size, fill: spell-gray-800)[#b.at("amount", default: "—")],
    )).flatten(),

    // Total row
    text(font: heading-font, size: body-size, fill: spell-dark, weight: "bold")[Total],
    text(font: heading-font, size: body-size, fill: spell-purple, weight: "bold")[
      #data.at("total_budget", default: "—")
    ],
  )
]
