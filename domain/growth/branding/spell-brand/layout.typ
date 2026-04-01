// Spell brand page layouts
#import "colors.typ": *
#import "typography.typ": *
#import "components.typ": page-footer

/// Standard report page template with header band and footer.
/// Returns a `set page(...)` + `show` rule block; call at document root.
/// - title: report title shown in the header (string)
/// - subtitle: report subtitle shown below title (string, default none)
#let report-page(title, subtitle: none) = {
  set page(
    paper: "a4",
    margin: (top: 72pt, bottom: 56pt, left: 56pt, right: 56pt),
    header: [
      #grid(
        columns: (1fr, auto),
        [
          #text(font: heading-font, size: h3-size, fill: spell-dark, weight: "bold")[#title]
          #if subtitle != none [
            #h(6pt)
            #text(font: body-font, size: small-size, fill: spell-gray-500)[#subtitle]
          ]
        ],
        image.decode(
          // Inline SVG placeholder for logo — hex values here are inside a raw string literal
          `<svg xmlns="http://www.w3.org/2000/svg" width="80" height="20">
            <rect width="80" height="20" rx="4" fill="#7C3AED"/>
            <text x="8" y="14" font-family="sans-serif" font-size="11" fill="white" font-weight="bold">spell</text>
          </svg>`.text,
          format: "svg",
          width: 60pt,
        ),
      )
      #line(length: 100%, stroke: 1pt + spell-purple)
    ],
    footer: page-footer(title),
  )
  set text(font: body-font, size: body-size, fill: spell-gray-800)
  set heading(numbering: none)
  show heading.where(level: 1): it => text(
    font: heading-font, size: h1-size, fill: spell-dark, weight: "bold",
  )[#it.body]
  show heading.where(level: 2): it => text(
    font: heading-font, size: h2-size, fill: spell-dark, weight: "semibold",
  )[#it.body]
  show heading.where(level: 3): it => text(
    font: heading-font, size: h3-size, fill: spell-gray-700, weight: "medium",
  )[#it.body]
}

/// Branded cover page.
/// Produces a full-bleed purple cover and resets the page counter.
/// - title: document title (string)
/// - subtitle: document subtitle (string, default none)
/// - date: display date string (string, default auto-formatted today)
#let cover-page(title, subtitle: none, date: none) = {
  let display-date = if date != none {
    date
  } else {
    datetime.today().display("[month repr:long] [day], [year]")
  }

  page(
    paper: "a4",
    margin: (x: 64pt, y: 72pt),
    fill: spell-dark,
    header: none,
    footer: none,
    [
      // Top brand mark — SVG string literal; hex values cannot use Typst variables inside raw XML text
      #align(top + right)[
        #image.decode(
          `<svg xmlns="http://www.w3.org/2000/svg" width="100" height="28">
            <rect width="100" height="28" rx="5" fill="#7C3AED"/>
            <text x="10" y="19" font-family="sans-serif" font-size="14" fill="white" font-weight="bold">spell</text>
          </svg>`.text,
          format: "svg",
          width: 80pt,
        )
      ]

      #v(1fr)

      // Title block
      #block(
        inset: (bottom: 24pt),
        [
          #text(
            font: heading-font,
            size: 32pt,
            fill: white,
            weight: "bold",
          )[#title]
          #if subtitle != none [
            #v(8pt)
            #text(
              font: body-font,
              size: h3-size,
              fill: spell-light,
            )[#subtitle]
          ]
        ],
      )

      #line(length: 100%, stroke: 1pt + spell-purple)
      #v(12pt)
      #text(font: body-font, size: small-size, fill: spell-gray-400)[#display-date]

      #v(1fr)
    ],
  )

  // Reset page counter so page 1 starts after the cover.
  counter(page).update(0)
}
