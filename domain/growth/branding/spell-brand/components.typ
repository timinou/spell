// Spell brand reusable components
#import "colors.typ": *
#import "typography.typ": *

/// A single metric display box.
/// - label: the metric name (string)
/// - value: the primary metric value (string)
/// - delta: optional change indicator, e.g. "+12%" (string or none)
#let stat-cell(label, value, delta: none) = block(
  fill: spell-gray-50,
  stroke: 0.5pt + spell-gray-200,
  radius: 4pt,
  inset: 12pt,
  [
    #text(font: body-font, size: small-size, fill: spell-gray-500)[#label]
    #v(4pt)
    #text(font: heading-font, size: h2-size, fill: spell-dark, weight: "bold")[#value]
    #if delta != none [
      #v(2pt)
      #text(
        font: body-font,
        size: small-size,
        fill: if delta.starts-with("-") { spell-error } else { spell-success },
      )[#delta]
    ]
  ],
)

/// Styled section header with a left accent bar.
/// - title: section title text (string)
#let section-header(title) = block(
  below: 8pt,
  above: 16pt,
  [
    #grid(
      columns: (4pt, 1fr),
      gutter: 8pt,
      block(fill: spell-purple, height: h2-size + 4pt, width: 4pt),
      text(
        font: heading-font,
        size: h2-size,
        fill: spell-dark,
        weight: "bold",
      )[#title],
    )
    #line(length: 100%, stroke: 0.5pt + spell-gray-200)
  ],
)

/// Horizontal row of stat-cells with equal column widths.
/// - metrics: array of dicts with keys: label, value, delta (optional)
#let metric-strip(metrics) = grid(
  columns: metrics.len(),
  gutter: 8pt,
  ..metrics.map(m => stat-cell(
    m.at("label", default: ""),
    m.at("value", default: "—"),
    delta: m.at("delta", default: none),
  )),
)

/// Styled callout box.
/// - content: body content (content)
/// - type: "info" | "warning" | "success" (string, default "info")
#let callout-box(content, type: "info") = {
  let (fill-color, border-color, label) = if type == "warning" {
    (spell-warning.lighten(88%), spell-warning, "Warning")
  } else if type == "success" {
    (spell-success.lighten(88%), spell-success, "Note")
  } else {
    // info (default)
    (spell-light, spell-purple, "Info")
  }

  block(
    fill: fill-color,
    stroke: (left: 3pt + border-color),
    inset: (x: 12pt, y: 8pt),
    radius: (right: 4pt),
    below: 12pt,
    [
      #text(font: heading-font, size: small-size, fill: border-color, weight: "bold")[#label]
      #v(4pt)
      #text(font: body-font, size: body-size, fill: spell-gray-700)[#content]
    ],
  )
}

/// Page footer with custom text, date, and page number.
/// - label: descriptive footer text (string)
#let page-footer(label) = locate(loc => {
  let page-num = counter(page).at(loc).first()
  let total = counter(page).final(loc).first()
  block(
    above: 0pt,
    below: 0pt,
    width: 100%,
    [
      #line(length: 100%, stroke: 0.5pt + spell-gray-200)
      #v(4pt)
      #grid(
        columns: (1fr, auto, 1fr),
        text(font: body-font, size: small-size, fill: spell-gray-400)[#label],
        text(font: body-font, size: small-size, fill: spell-gray-400)[
          #datetime.today().display("[month repr:long] [day], [year]")
        ],
        align(
          right,
          text(font: body-font, size: small-size, fill: spell-gray-400)[
            #page-num / #total
          ],
        ),
      )
    ],
  )
})
