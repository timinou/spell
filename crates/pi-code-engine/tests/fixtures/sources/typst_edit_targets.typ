#set document(
  title: "Editable scope fixture",
  author: "Spell",
)

// editable comment before bindings
#let teal-primary = rgb("#008080")

This paragraph stays as markup.

#let section-title(num, title) = {
  [#num --- #title]
}

// trailing editable comment
