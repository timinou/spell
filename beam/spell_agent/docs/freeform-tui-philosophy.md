# The Dissolving Interface — a philosophy of the freeform TUI

> An aspirational companion to `freeform-tui-architecture.md`. The architecture
> doc says *what we are building*. This says *why it matters* and *how far it
> goes*. Read it when you want the whole horizon, not the next commit.
>
> Research lineage: `PROJ-001..005` in `!tasks/projects/`.

---

## Prologue: an interface that can be rewritten by what it displays

Start from the strangest fact about this system and let it lead.

The agent inspects a coding session through a terminal UI. The UI is built from
PTC-Lisp values. The agent *writes* PTC-Lisp. Therefore the agent can rewrite the
UI that is inspecting it — in the same language it is being inspected with. The
observer and the observed share a language, and that language is data.

This is not a feature we are adding. It is a property that *falls out* the moment
you notice that three things which look like different kinds of stuff are
secretly the same kind of stuff:

- the **tools** the agent calls are PTC values (already true — `define-tool`),
- the **keybindings** that drive the UI are PTC values (already true — the
  Reaction DSL),
- the **layout** that renders the UI is — once we finish — also a PTC value.

When all three are data in one language, the boundaries between them stop being
walls and start being conveniences. And once you pull on *that* thread, a whole
row of boundaries — ones that feel utterly fundamental when you start — come
loose one after another.

This document is the catalogue of those boundaries, and the argument that
dissolving them is not a trick but the natural endpoint of one idea: **the
interface is made of the same stuff as the mind using it.**

---

## The one principle

> **Every layer dissolves a boundary that currently looks fundamental.**

That is the whole thesis. Each capability below takes a distinction that seems
like a law of how software works — output vs. workspace, present vs. history,
taught vs. learned, looking vs. acting, mine vs. ours — and shows it was only ever
a consequence of *state being trapped in the wrong representation*. Free the
representation (make it homoiconic data in the language the agent speaks) and the
boundary was never load-bearing.

Every one of these is unlocked by the **same primitive** — *the tree is data* —
plus **one substrate we already have**: the history store, the memory graph, the
effect sandbox, the BEAM itself.

---

## Layer 0: the ground (what `PLAN-009` actually builds)

Before the dissolutions, the floor they stand on.

The terminal UI today is rendered by a hardcoded Elixir function, `render/2`. It
splits the screen, places panes, and reads a separate navigation struct (`%Ui{}`)
to decide what is highlighted. Three things are fused in that function that want
to be free: the **layout** (how the screen divides), the **content** (what each
region shows), and the **navigation state** (where you are looking).

`PLAN-009` unfreezes them into a single value: a **layout tree** of plain maps.
A node is a split, a pane, or a widget; every node carries a `:tags` bag. The
old navigation struct *dissolves into the tree* — "focus" is a tag on the node
that has it, "cursor" is a tag on the pane it scrolls. Navigation becomes a pure
function that re-tags the tree. Rendering becomes a pure walk of the tree. The
agent reshapes the tree by writing PTC.

This is itself the first dissolution, the quiet one:

> **Layer 0 dissolves: the interface vs. the state of the interface.**
> There is no UI and a separate cursor-into-the-UI. There is one tree that is
> simultaneously the structure, the content, and the gaze. Nothing can desync
> because there is nothing to sync.

Everything below is what becomes *possible* once the interface is one
inspectable, rewritable value.

---

## Layer −1: output vs. workspace

**The boundary:** a UI is something you render *for someone else to look at*. It
is an output. The thing rendering it does not *use* it; it *emits* it.

**Why it looks fundamental:** of course the renderer doesn't read its own output —
output flows one way, from program to screen to human eye. That's what "output"
*means*.

**How it dissolves:** the layout tree is data, and the data the UI displays is the
agent's own run-trace. So the agent can author a layout *for itself* — a headless
view that organizes its own trace to think over. When stuck on a tangled failure,
it lays out "the errored tool calls | the def-env at that turn | the source they
touched," renders it to a buffer (no screen needed — `init_test_terminal` +
`get_buffer_content`), and reads that buffer back as reasoning input. It draws to
think.

The renderer reads its own output. The UI becomes **external working memory**.
"Output" was never one-way; it was one-way *because nothing downstream of the
screen could read pixels back*. The agent can read the data the pixels came from.

> **−1 dissolves: output vs. workspace.** The interface is not what the agent
> shows; it is where the agent thinks. (`PROJ-001`)

---

## Layer −2: present vs. history

**The boundary:** an interface is its current frame. The way it looked three turns
ago is gone — unless you explicitly built a snapshot system to remember it.

**Why it looks fundamental:** a screen shows *now*. Past states aren't anywhere;
they were overwritten by the next frame. History is something you bolt on with
deliberate machinery.

**How it dissolves:** we already have machinery that records every PTC value the
agent runs as a node in a forest, with full provenance — what turn made it, what
it cost, the program as a walkable tree. A layout is a PTC value. So a layout is
*already the shape that machinery stores.* Recording it is nearly free.

And once layouts are nodes in the history forest, the layout at turn N is just the
node at sequence N. **Scrub the timeline and the interface rewinds with it** — not
because we built undo, but because the past state was never gone; it was a value
in the store the whole time, like every other value. You can ask structural
questions of your own UI history ("every dashboard I built that nested a chart in
a pane") with the same lens engine that queries past programs.

History stops being a feature of the interface and becomes a *property of values
living in a store that remembers*.

> **−2 dissolves: present vs. history.** The interface has a past because
> everything the agent makes is remembered with provenance, in one substrate.
> Time-travel is not built; it is *noticed*. (`PROJ-002` — recording seam folded
> into v1.)

---

## Layer −3: taught vs. learned

**The boundary:** what the agent knows about its tools (the "prelude") is authored
by us. Knowledge flows from designer to system. The system does not write its own
manual.

**Why it looks fundamental:** the documentation is upstream of the agent. We write
what it knows; it reads. A system teaching itself its own capabilities is a
category error — where would the new knowledge *come from*?

**How it dissolves:** the *grammar* of the UI (which widgets exist, their fields)
is reflected from the widget structs — correct by construction, ours, fixed. But
the *idioms* — "a cost-histogram pane," "a focus-the-most-errors traversal" — are
discovered by the agent at runtime, recorded with provenance (Layer −2), and
tagged with whether they *worked* (the turn succeeded, the human kept the view).
The memory graph already distills episodes into reusable concepts with provenance
edges. A layout that worked and got reused is exactly such an episode.

So the prelude becomes two halves: **grammar** (reflected, ours) and **idioms**
(distilled, the agent's prior self's). It bootstraps its own component library.
The new knowledge comes from *its own successful past*, filtered by what
demonstrably helped.

The manual writes a chapter. Reflection gives the vocabulary; experience gives the
sentences worth saying.

> **−3 dissolves: taught vs. learned.** What the agent knows about its interface
> is partly authored by the agent that used it. (`PROJ-003`)

---

## Layer −4: looking vs. acting

**The boundary:** a view *shows* you state; you then take an *action* to change
it. Looking is passive and safe; acting is active and consequential. They are
different phases of a workflow.

**Why it looks fundamental:** rendering must be pure — a frame that has side
effects, that costs money or mutates files just by being drawn, is obviously
insane. So display and effect are necessarily separate. We even enforce it in v1:
a pane's render may *not* call effectful tools.

**How it dissolves — and the care it demands:** the render contract is just
"node → placement subtree." Nothing structural forbids a pane whose content *is* a
live query: "show the callers of the symbol under my cursor" as a *layout* rather
than a workflow. The codebase is queried as the UI renders; looking at it and
asking about it become one gesture.

But this is the boundary where dissolving carelessly is catastrophic, and the
careful form is more beautiful than the reckless one. The reckless form puts
effects on the frame clock (disaster: loops, per-frame cost, a UI that edits files
by being displayed). The careful form moves the boundary instead of deleting it:
a pane **declares a data dependency** — "I need the callers of the cursor symbol"
— and the runtime satisfies it *on cursor-change* (the keystroke clock,
debounced), injecting the result as data. Render stays pure. The UX is identical
— a live callers pane that updates as you move — but the effect happened on a slow
clock, once, cached, not on every frame.

This is the LiveView insight in homoiconic clothing: a view is a pure function of
its assigns; "live" data is a *declared dependency the runtime resolves*, not an
effect the view performs. The boundary between looking and acting doesn't vanish —
it *relocates* from "render vs. workflow" to "declare vs. resolve," which is
exactly where it does no harm.

When that lands, there is no longer a line between inspecting the codebase and
operating on it. This is, arguably, where "the interface *is* the agent"
terminates.

> **−4 dissolves: looking vs. acting** — carefully, by relocating the boundary
> to "declare vs. resolve" rather than erasing it. (`PROJ-004`. Security is
> load-bearing here, not secondary; start read-only, reactive-cell framing first.)

---

## Layer −5: mine vs. ours

**The boundary:** an interface belongs to one session, one process, one mind. My
screen is mine; your screen is yours. Sharing means copying or streaming pixels.

**Why it looks fundamental:** a UI is local. It lives in one process's memory and
paints one terminal. Two minds sharing *one live interface* means solving
distributed shared mutable state — famously the hardest thing in computing.

**How it dissolves:** the tree is plain data, and the BEAM is built — at its
foundation — for sharing data between processes and nodes by message passing. We
already plan read-only cross-session inspection (one session watching another,
"because it is the BEAM"). Drop "read-only" and two minds **co-edit one tree**:
one moves focus and the other sees the cursor travel; one authors a pane and it
appears for both. Pair programming where the shared artifact is the living
interface itself, edited in the language both inspect it with.

The hard part — concurrent-edit merge — is tamed by the tree's *smallness* (a
handful of slots) and by one elegant split that turns out to *be* the resolution
of mine-vs-ours: **the structure and content are ours; the gaze is mine.** The
tree is shared, but focus and cursor are per-participant tags. Two minds look at
different parts of the same living thing. "Ours" governs what the interface *is*;
"mine" governs *where I stand in it*. That is not a compromise between mine and
ours — it is the precise sense in which both were always true at once, finally
representable because the gaze is just a tag and tags can be namespaced.

> **−5 dissolves: mine vs. ours.** The interface is a shared medium of cognition —
> human and model, homoiconic on both ends — where the artifact is common and the
> standpoint is personal. (`PROJ-005` — the endgame.)

---

## The shape of the whole

Read the dissolutions in order and a pattern shows itself. Each one takes a
distinction that feels like a law:

| layer | boundary dissolved | the law it turned out not to be |
|---|---|---|
| 0 | interface vs. its state | state was trapped in a side-struct |
| −1 | output vs. workspace | output couldn't be read back |
| −2 | present vs. history | the past wasn't stored as values |
| −3 | taught vs. learned | knowledge only flowed one way |
| −4 | looking vs. acting | effects were welded to display |
| −5 | mine vs. ours | gaze and artifact were one object |

In every row, the boundary was real *only as a consequence of the wrong
representation*. Trapped state, unreadable output, unstored pasts, one-way
knowledge, welded effects, fused gaze-and-artifact. Each is a representational
accident, not a law of interfaces. And each is freed by the *same* act: make the
thing homoiconic data in the language the agent speaks, then notice the wall was a
shadow.

This is why the work is worth doing slowly and exactly. We are not adding six
features. We are removing six accidents, and what is left when they are gone is a
single, simple object — **a tree of data, shared by every clock and every mind
that touches it** — that happens to be, in turn, the interface, the workspace, the
memory, the manual, the query, and the meeting place.

---

## What we are building now, and what we are letting wait

Honesty about scope keeps the vision from becoming vapor.

**In `PLAN-009` (now):**
- Layer 0 in full — the layout tree, the lens-navigation, the render mirror,
  reflection-driven no-drift, theme reflection, the same-node inspector.
- The **recording seam** of Layer −2 — authored layouts recorded as history
  nodes, so provenance exists from day one even before time-travel is built on it.

**Research-track (`PROJ-001..005`), captured in exquisite detail, deliberately
not yet:**
- −1 (self-workspace), −3 (self-writing prelude), −5 (shared tree): each waits on
  Layer 0 being real and on its own substrate maturing (headless-reason loop,
  memory distillation, distributed merge).
- −2 full time-travel: waits on the recording seam proving out.
- −4 (effects in render): waits *deliberately* on the reactive-cell framing and a
  capability/budget model — the one layer where moving fast would be moving
  recklessly.

The order is not arbitrary. Layer 0 makes the tree data. −2's seam makes it
remembered. Everything else stands on *data that is remembered* — a workspace
worth keeping, a history worth scrubbing, idioms worth distilling, effects worth
auditing, a shared thing worth trusting. We build the floor and the memory first,
then dissolve the walls one careful boundary at a time.

---

## Coda

The first time you watch the agent rewrite the pane that is displaying its own
reasoning, in the language that reasoning is written in, something clicks that no
feature list conveys: the interface was never a separate thing the agent *had*. It
was always just more of the agent's own substance, briefly wearing the shape of a
screen. We are not building a configurable UI. We are letting the agent's medium
and the agent's mind be made of the same data — and then getting out of the way
while the walls between them turn out to have been drawn in chalk.
