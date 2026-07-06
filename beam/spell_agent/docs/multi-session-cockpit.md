# Multi-session cockpit — the concurrent-session view as a layout value

> **Status: PLANNED (PLAN-026, FEAT-046).** The read substrate ships
> (`SessionRegistry.lineage/0`, `DataBag.snapshot_from/2`, `Spawn.create/2`) and
> the freeform render surface it rides is real (`LayoutRegistry` slot shadowing,
> reflected `view/` builders, `lens/*` traversals, runtime panes via
> `harness/declare-pane`). This document is the settled vision; the org items are
> the executable plan. Read claims here as the target the plan lands, not all
> shipped today.
>
> Tracking: `FEAT-046` (deliverable), `PLAN-026` (waved execution), `FUP-035`
> (the one oracle-gated part: `human/interrupt`). Supersedes the read-only
> `SessionBrowser` (`mix spell.sessions`).

---

## 1. The thesis: the cockpit is a layout value, not a module

One human runs many concurrent agent sessions. They need to *see* all of them at
once — who is running, who spawned whom, toward what, how it is going — and
*steer* them: watch one closely, spawn a new one, halt a runaway.

The obvious implementation is the wrong one. `SpellAgent.Tui.SessionBrowser`
already exists: a separate `ExRatatui` app, `mix spell.sessions`, ~340 lines of
hardcoded Elixir — `render/2`, `handle_key`, `move_list`, a fixed two-column
split, `list_widget`/`trace_widget` built by hand. Every new arrangement is an
Elixir recompile. That is **body-logic doing a mind's job**: the arrangement, the
card content, the status colors, the ordering — all of it is *policy*, and policy
belongs in the language the agent writes.

The doctrine (`docs/body-and-mind.md`, `docs/freeform-tui-philosophy.md`):

> **Elixir is the body** — primitives, invariants, safety, materialization.
> **BEAM Lisp is the mind** — policy, behaviour, arrangement, lenses.
> Friction is mind-logic trapped in the body.

So the cockpit is not a module. It is a **`body`-slot layout value** — a `.ptc`
program the agent authors — projecting one new bounded data binding
(`data/sessions`). The freeform TUI architecture already named this exact usecase
in its pressure-test table (`docs/freeform-tui-architecture.md` §5):

> | ditch inspector → 3-up diff dashboard | `body` or `frame` | full program |

A multi-session cockpit *is* that dashboard, where the projected data is
`data/sessions` instead of `data/forest`. The freeform surface was built so this
costs almost no new body.

---

## 2. What the cockpit is made of

```
data/sessions          the ONE new binding — registry lineage ⋈ Hist snapshot   (body: Cockpit.sessions/1)
cockpit_layout.ptc     the WHOLE visual — grid, cards, colors, ordering          (mind: a body-slot value)
cockpit reactions      focus ring + drill/back as lens ops over tags-on-tree     (mind: keymap data)
human/*                steer a session by id — list/watch/spawn/adopt/interrupt   (mind surface: thin verbs)
```

**Body grows by ~1 materializer + 1 transport read. Mind grows by 2 `.ptc` files
+ a verb namespace.** That ratio is the point.

---

## 3. The one new body primitive — `Cockpit.sessions/1`

The only genuinely new *read* Elixir. Read-only, bounded, best-effort. It unions
the two halves of "what sessions exist":

- **live meta** — `SessionRegistry.lineage/0` →
  `[%{session_id, owner, parent_id, intent, region, status}]`. Who is running
  right now, who spawned whom, toward what goal, in which mesh region. Already
  ships (FEAT-044 substrate).
- **content** — per session, `DataBag.snapshot_from(spans, vms)` → a string-keyed
  data map with turns, cost, running?, the last activity line, the last-N spans.

It reads the **shared Hist substrate**, not the target session's pid — the
read-through path the freeform doc prefers for cross-session inspection
(`FUP-006`): "a second process reads the target's layout tree (plain data)
… read-only". No coupling to the target's event loop; the only cost is
refresh-clock lag (sub-second, tunable).

```elixir
defmodule SpellAgent.Tui.Cockpit do
  @moduledoc "Materializes data/sessions: registry lineage ⋈ per-session Hist snapshot."

  @max_sessions 12    # bound the grid — atom-table & render-cost floor
  @snapshot_turns 3   # only the last-N spans per card in the overview

  @spec sessions(module()) :: [map()]
  def sessions(store) do
    SessionRegistry.lineage()
    |> Enum.take(@max_sessions)
    |> Enum.map(&decorate(&1, store))   # ⋈ content, per-row, best-effort
  end

  defp decorate(%{session_id: sid} = meta, store) do
    snap = safe_snapshot(store, sid)    # DataBag.snapshot_from under try/rescue
    Map.merge(stringify(meta), %{
      "turns" => snap.turns, "cost" => snap.cost, "running?" => snap.running?,
      "last" => snap.last_line, "status" => snap.result_tag || "running",
      "spans" => Enum.take(snap.spans, -@snapshot_turns)
    })
  end
end
```

Injected as `data/sessions` in `DataBag` exactly like `data/forest`/`data/vms`
today, under the same cost guard, on the same refresh clock. That is the whole
read-Elixir surface.

The bounds (`@max_sessions`, `@snapshot_turns`), the per-row `try/rescue`, and the
string-keying are the body's *only* jobs: bound the cost, never let one sick
session crash the view, hand PTC clean data. It decides **nothing** about how any
of it looks.

---

## 4. The cockpit layout — `priv/tui/cockpit_layout.ptc`

The deliverable's heart. Rides the `body` slot; projects `data/sessions` into an
N-up responsive grid of per-session cards. Every visual decision is a PTC
expression:

```clojure
;; The multi-session cockpit — as data (FEAT-046, PLAN-026).
;; Rides the `body` slot: projects data/sessions (registry lineage ⋈ Hist
;; snapshot) into an N-up grid of per-session cards. Focus is a tag on one card;
;; drill-in is a tag on the body pane. Everything here is a value layout/set can
;; shadow — an edit reshapes the cockpit with no Elixir recompile.

(let [sessions data/sessions
      n        (count sessions)
      focused  (get-in data/tree [:tags :focus-session])   ;; focused card id, or nil
      drilled? (get-in data/tree [:tags :drilled])          ;; overview grid vs single-session detail
      cols     (grid-cols n)]

  (if drilled?
    ;; DRILL-IN: one session, full inspector — reuse the single-session default layout
    (session-detail (find-session sessions focused))

    ;; OVERVIEW: a responsive grid of session cards
    (view/split {:dir "vertical" :constraints [[:length 1] [:min 0] [:length 1]]}
      (cockpit-header n (count-running sessions))            ;; "5 sessions · 3 running · fork-a▪fork-b"
      (grid cols
        (for [s sessions]
          (session-card s (= (get s "id") focused))))
      (cockpit-hints focused drilled?))))
```

with the card + grid builders — also data:

```clojure
;; A single session card — a focusable pane whose border + glyph reflect live status.
(defn session-card [s focused?]
  (view/pane {:slot (str "session/" (get s "id"))
              :focusable true
              :tags {:focused focused? :session-id (get s "id")}
              :render
    (view/block {:title (card-title s)                        ;; "sess-ab12  refactor auth  ●3t $0.42"
                 :border-style (status-border (get s "status") focused?)}
      (view/list
        (concat
          [(view/line (str (owner-glyph (get s "owner")) " " (get s "intent")))
           (view/line (str "⤷ " (get s "last")))]
          (for [span (get s "spans")]
            (view/line (str (span-glyph (get span "status")) " " (get span "title")))))))}))

;; Grid geometry — PURE math over n. This is the "responsive" part, in data.
(defn grid [cols cards]
  (view/split {:dir "vertical" :constraints (even-splits (ceil (/ (count cards) cols)))}
    (for [row (partition-all cols cards)]
      (view/split {:dir "horizontal" :constraints (even-splits (count row))} row))))

(defn grid-cols [n] (cond (<= n 1) 1 (<= n 4) 2 (<= n 9) 3 :else 4))
```

Read what this buys. The grid breakpoints, the card content, the status colors,
the "doing now" line, the header format — **every visual decision is a PTC
expression the agent edits live**:

- session cost as a sparkline instead of a number → rewrite `card-title`
- failed sessions float to the top-left → `(sort-by fail-rank sessions)` before the `for`
- a 2-column diff-dashboard of two specific sessions → `layout/set` a different `body`

None of it touches Elixir. This is the maximum-BEAM-Lisp shape: cost scales with
ambition, nothing is unreachable, the 90% case is a one-liner.

---

## 5. Navigation — the focus ring is `lens/` ops

The cockpit's focus ring is the set of `session/*` panes. Moving between cards and
drilling in are **named traversals** — pure `tree → tree`, the exact `lens/`
primitives FEAT-039 shipped. They are authored as reactions bound to keys, so they
are rebindable *and* redefinable:

```clojure
;; "cockpit/next-session" — move focus to the next card (zipper-ordered, wraps)
(keymap/define-reaction "cockpit/next-session"
  (fn [tree] (lens/retag-focus tree :next)))

;; "cockpit/drill" — enter the focused session's full inspector
(keymap/define-reaction "cockpit/drill"
  (fn [tree]
    (lens/update-at tree "body"
      (fn [b] (-> b (assoc-in [:tags :drilled] true)
                    (assoc-in [:tags :focus-session] (harness/focused-tag tree :session-id)))))))

;; "cockpit/back" — pop out of drill-in to the overview grid
(keymap/define-reaction "cockpit/back"
  (fn [tree] (lens/update-at tree "body" (fn [b] (assoc-in b [:tags :drilled] false)))))
```

The drill-in **reuses the single-session default layout unchanged** — it feeds
that session's snapshot as `data/forest` to the existing inspector projection. So
the inspector you already have *is* the drill view, for free. One render path
(`docs/freeform-tui-architecture.md` §7); no second rendering codebase.

`session/*` are runtime pane names — accepted by `Ui.safe_pane/1` via
`harness/declare-pane` + `PaneRegistry` (FUP-005, shipped), **without interning**.
The bounded-vocabulary atom chokepoint holds.

---

## 6. `human/*` — the mind surface for steering

Parts 4-5: the human *acts on* the mesh, not just watches it. A `Namespace.Spec`
in the catalog (the Wave-1 registry pattern), addressing one session among many by
id — analogous to `black/*` for agents:

| verb | body action | notes |
|---|---|---|
| `human/list` | `SessionRegistry.lineage/0` | the lineage subtree as data (script the cockpit) |
| `human/watch {id}` | set `body` drill tags | pure lens op — the drill reaction, callable |
| `human/spawn {intent, tools?, budget?}` | `Spawn.create(owner: :human)` | routes `App.submit` through the ONE gateway — a human-started session gets uniform lineage (closes part 4) |
| `human/interrupt {id}` | cooperative halt at the turn gate | the ONE part needing new invariant design → `FUP-035` |
| `human/adopt {id}` | re-parent an orphan to `:human` | registry meta update, best-effort |

Only `human/interrupt` needs a genuinely new body affordance. The rest are lens
ops or gateway calls that already exist. **Steering is mostly data.**

### The one design gate: `human/interrupt`

A forced interrupt that lands mid-tool — specifically mid-NIF-edit
(`SpellAgent.Find.edit_tool`) — is a partial-write hazard. The stakes doctrine
forbids a naive `Process.exit`. The interrupt **must be cooperative**: a
per-session flag the mission loop reads at the *same* `check_termination` seam
`loop/continue` already gates at, between turns, never mid-tool. An in-flight tool
completes (or hits its own bound); the interrupt is observed at the next gate.

This is the loop/continue discipline repeated: an agency primitive that changes a
runtime invariant gets an **oracle design pass before impl** (`FUP-035`,
`PLAN-026` W-C5), not a hand-wave.

---

## 7. Failure ladder — the screen never bricks

Per-slot, extended to the cockpit's live data:

```
Cockpit.sessions/1 raises          → data/sessions = last-good (cached) → []
cockpit_layout.ptc raises/bad shape → last-good cockpit tree → compiled fallback
                                        (a minimal 1-column session-id list, snapshot-tested)
a single session's snapshot fails   → that card renders "(snapshot unavailable)";
                                        the OTHER cards are unaffected (per-row try/rescue)
registry down                       → lineage() → [] → "(no live sessions)"; never crashes
```

The floor — a compiled 1-column id list — ships and is snapshot-tested via the
existing `SceneRender` headless-buffer path. The cockpit degrades to "a boring
list"; it never degrades to a crash.

---

## 8. What it looks like

Overview (5 sessions, 3 running, `grid-cols → 3`):

```
┌ 5 sessions · 3 running · fork-a ▪ fork-b ─────────────────────────────────┐
│ ┌─sess-ab12 ●3t $0.42──────┐ ┌─sess-cd34 ●7t $1.10──────┐ ┌─sess-ef56 ✓───┐│
│ │ ⌂ refactor auth          │ │ ⤷ spawned: run tests     │ │ ⌂ write docs  ││
│ │ ⤷ editing registry.ex    │ │ ⤷ 14 tests passing…      │ │ ✓ done        ││
│ │ ✓ read session_registry  │ │ ✓ mix compile            │ │ ✓ 3 files     ││
│ │ · editing…               │ │ ✗ flaky: app_test:412    │ │               ││
│ └──────────────────────────┘ └──────────────────────────┘ └───────────────┘│
│ ┌─sess-gh78 ●1t $0.08──────┐ ┌─sess-ij90 (queued)───────┐                   │
│ │ ⤷ child of ab12          │ │ ⌂ audit deps             │                   │
│ │ ⤷ grepping imports       │ │ … waiting for slot       │                   │
│ └──────────────────────────┘ └──────────────────────────┘                   │
└ [tab] next  [↵] drill in  [s] spawn  [x] interrupt  [q] back ───────────────┘
```

Focused card = bright border (`status-border … focused? → :cyan`); running =
`●Nt` + green; failed span = `✗` red; child sessions show `⤷ child of <parent>`
from `parent_id`. Drill-in (`↵`) → the existing single-session inspector, fed that
session's snapshot; `[q]` pops back. Zero new render code.

---

## 9. Execution — the waved plan (`PLAN-026`)

```
W-C1  body seam        Cockpit.sessions/1 + data/sessions binding + failure ladder
W-C2  layout data      cockpit_layout.ptc + card/grid builders + compiled fallback floor
W-C3  navigation       lens focus ring over session/* + drill/back reactions
W-C4  steering         human/* Namespace.Spec + App.submit → Spawn.create gateway
W-C5  interrupt gate    ORACLE design → human/interrupt cooperative signal (FUP-035)
S-C   review swarm      atom-DoS · render-cost · transport-safety · never-brick
```

**Doctrine gate at every wave:** if a wave adds an Elixir clause that *decides*
layout, arrangement, or content, it is misplaced — that logic belongs in the
`.ptc`. Elixir may only materialize (`Cockpit.sessions/1`), bound
(`@max_sessions`, `safe_*`), transport (read the store), and fall back (the
floor). Everything the human sees, and how it is arranged, is data.

---

## 10. Boundaries → tracked FUPs (not scope-cuts)

| deferred | why | tracking |
|---|---|---|
| Zero-lag live content (telemetry attach vs read-through-store) | store-read is the right read-only v1; attach is heavier | `FUP-006` |
| `human/interrupt` cooperative-signal invariant | changes a runtime invariant → oracle-gated | `FUP-035` (W-C5) |
| Durable authored cockpit layouts across sessions | in-memory v1, like `LayoutRegistry` today | `FUP-009` |
| Multi-node distributed cockpit | out of single-human alpha scope | `FUP-020/021` |

---

## 11. References (code, verified in-tree)

- Live meta: `lib/spell_agent/session_registry.ex` `lineage/0` (L144)
- Content snapshot: `lib/spell_agent/tui/data_bag.ex` `snapshot_from/2` (L100)
- Spawn gateway: `lib/spell_agent/spawn.ex` `create/2`
- Layout-as-data precedent: `priv/tui/default_layout.ptc` + `lib/spell_agent/tui/default_layout.ex`
- Slot shadowing: `lib/spell_agent/tui/layout_registry.ex` (`set`/`show`/`reset`/`tree`, frozen identity)
- Reflected builders: `lib/spell_agent/tui/view.ex` (`view/<widget>`, `view/split`)
- No-drift coercion: `lib/spell_agent/tui/materialize.ex` `to_struct/1`
- Lens traversals: `lib/spell_agent/tui/lens.ex` (`retag-focus`/`update-focused`/`at-slot`/`update-at`)
- Runtime panes: `lib/spell_agent/tui/ui.ex` `safe_pane/1` (L240) + `pane_registry.ex` (FUP-005)
- Body-slot render path: `lib/spell_agent/tui/app.ex` `render_tree/1` (L322)
- Superseded read-only surface: `lib/spell_agent/tui/session_browser.ex`
- Vision context: `docs/freeform-tui-architecture.md` (§5 body-as-slot, §9 tags-on-tree), `docs/body-and-mind.md`
