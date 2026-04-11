#import "theme.typ": *
#let title = [Spell]
#show heading.where(level: 1): it => text(fill: red)[#it.body]

= #title
