# The Body and the Mind — what the body must do for the mind to be free

> **Status: VISION / DOCTRINE.** The body/mind freedom argument. Partially
> realized: A2 self-wake (PLAN-014) is the shipped example; much mind-logic is
> still trapped in Elixir (reducers, layout, the namespace seam). The
> PoC→alpha consolidation (PLAN-025) is the executable plan that closes the gap.

> Elixir is the body, Beam Lisp is the mind. This is intelligence at its finest:
> self-reflexivity.
>
> A companion to `freeform-tui-philosophy.md`. That doc catalogues the boundaries
> that dissolve. This one asks the inverse question: given that split, **what must
> the body do so the mind is free?** Captured verbatim from the conversation that
> produced it.

---

The seam is visible in the code: `build_tools_map/0` is the **corpus callosum** —
every native fn, freeform surface, and self-authored PTC tool collapses into one
`name → callable` map, and `to_callable` re-runs mind-authored source through the
same interpreter as everything else. That single map *is* the body/mind boundary.
So the question "what would the body do for the mind to be free" is really: **what
shape must that seam take so the mind never hits a wall the body forgot to open.**

## The principle

> The body's job is not to act for the mind. It's to make every faculty the mind
> could want **already be a value the mind can name.**

Freedom of mind = absence of *untouchable surface*. Every place the body does
something the mind cannot express is a bar in the cage. So the design goal is
mechanical: **drive the count of body-only capabilities toward zero**, and make
the residue (the things that genuinely must stay compiled) *thin, reflected, and
self-describing* — so even the bars announce themselves.

A mind is free along an axis iff that axis is **reified** (a value it can read),
**addressable** (a name it can pass), and **rebindable** (a write it can make) —
RAR. Walk the body and score each axis.

## What the body must provide (RAR, axis by axis)

**1. One throat, no privileged callers.** ✓ mostly built. `build_tools_map`
already merges native + freeform + registry into one map, and `to_callable(:ptc)`
passes `build_tools_map()` *back in* — so a mind-authored tool calls natives and
other mind-tools indistinguishably. The body's duty here: **no capability
reachable from Elixir that isn't an entry in that map.** Today `sh`, `view/`,
`keymap/`, `lens/` are entries — good. The freedom test for any new Elixir
feature: *did it land as a map entry, or as a special case the mind can't name?*
If the latter, the cage grew.

> **Realized (A2, PLAN-014):** the first of these organs now exists —
> `SpellAgent.Clock`, a Khepri-durable self-wake scheduler. The mind writes
> `(tool/clock/at {:in "10m" :prompt …})` and the body re-enters `SpellAgent.run/2`
> when the timer fires — a *synthetic caller*. It is built exactly as this doc
> argues: a wake is persisted + rehydrated like a durable tool, and a body-enforced
> **wake budget** makes the rope safe (a runaway schedule throttles, never
> crashes). See the README "Agency" section. A3/A4/A6 (FEAT-013/011) compose on it.

**2. Effects as data, not as the body's secret.** The body owns IO, the NIF, the
network, the clock — it *must*, that's what a body is. Freedom isn't the mind
doing IO directly (that's not freedom, that's removing the sandbox). Freedom is
**every effect being a value the mind submits and a result the mind reads back.**
`sh` returns `%{exit out err lines}` — the effect happened in the body, the
*description and result are data*. The principle generalizes: the body is a
**pure-ish effect interpreter** — mind emits an effect-value, body performs it,
body returns a value. The mind never holds the file handle; it holds the *name of
the wanting* and the *shape of the result*. That's the −4 "declare vs resolve"
relocation, already half-articulated in the philosophy doc.

**3. The body must hand the mind its own trace.** ✓ substrate exists
(`hist/recorder`, `hist/lens`). For the mind to *think about itself* it must read
what it just did **as the same kind of value it writes.** The recorder storing
every PTC run as a forest node, queryable by the same lens engine — that's the
body giving the mind a mirror that is *made of mind-stuff*. The body's duty:
nothing the mind does escapes the recorder unrecorded, and the recording is in the
mind's own language (a walkable tree), not an opaque Elixir struct.

**4. The body must guarantee the mind cannot kill itself.** This is the
*non-obvious* freedom duty. A mind that can crash the BEAM by authoring one bad
tool is **not free — it's reckless, and recklessness gets you sandboxed harder.**
Freedom *expands* exactly as far as the body can make failure cheap and total.
`validate_source` → bounded validate; `to_callable` raising into an LLM-facing
payload instead of a process crash; the reaction vocabulary funnelled so a keybind
"can never grow the atom table" — every one of these is the body **buying the mind
more rope by making each rope safe.** The codebase should read as: *failure ladder
everywhere* — last-good → native default → surfaced-as-data error. The mind is
free in proportion to how survivable its mistakes are.

## What the codebase would look like

The endpoint is a body that is **thin, reflective, and effect-only**, with a mind
that is **thick, homoiconic, and total over the surface.** Concretely:

```
BODY (Elixir) shrinks to four organs:
  · interpreter     PtcRunner.Lisp.run        — the one evaluator, no second path
  · throat          build_tools_map           — every faculty is an entry here
  · effect-floor    sh / NIF / net / clock     — performs effect-values, returns data
  · recorder+store  hist/*                      — hands the trace back as mind-stuff
  + reflection      reflect.ex                  — body describes ITSELF as data

MIND (Beam Lisp) grows to own everything above the floor:
  · tools           define-tool                ✓ owns
  · keybindings     keymap/define-reaction     ✓ owns
  · layout          layout tree as PTC          ◑ landing (PLAN-009)
  · prompt/policy    define-config              ◑ partial
  · its own idioms   distilled from its trace   ✗ research (−3)
```

**The tell of a free body: reflection over enumeration.** `reflect.ex` already
exists — the body describes its own widgets/theme-slots/struct-fields *by
reflection* so the mind's vocabulary tracks the body automatically, no
hand-maintained mirror to rot (AGENTS.md: "reflect, don't hand-list"). Push this
to its limit: the mind should be able to ask the body **"what are you made of?"**
and get a data answer — the inventory (`list-tools`) is the seed; the full form is
the body's *entire capability surface* enumerable as values. When the mind can
read the body's shape, the body stops being a wall and becomes a *map*.

**The tell of a free mind: the second path is gone.** Right now `to_callable` has
two arms — `:native` (a raw fn) and `:ptc` (re-run source). The native arm is the
body's reserved territory. Freedom *advances* every time a native tool is
re-expressible as PTC and the native arm shrinks to the irreducible effect-floor.
The asymptote: native ≡ exactly the effects that touch the world (IO/NIF/net/clock),
and **everything compositional is mind.** You'd see the `native_tools` map stop
growing while the registry grows without bound.

## What stays body, forever — and why that's freedom not limitation

Self-reflexivity has a floor it cannot dissolve without ceasing to exist:

- **the interpreter cannot be mind.** Something must evaluate the lisp; that
  something is compiled. A mind that rewrote its own evaluator mid-eval has no
  stable "I" to do the rewriting. The body holds the eval loop *so there is a self
  to be free*.
- **the effect-floor cannot be mind.** The actual `write(fd)` is not data; only
  its description is. The body performs the irreducibly-physical so the mind can
  stay pure-and-total over the symbolic.
- **the safety ladder cannot be mind.** The thing that catches the mind's crash
  must outlive the crash. Body-held by necessity.

This is the deep shape: **the body is the mind's unconscious.** Not a limit on
freedom — the *condition* of it. You are not less free because you can't
consciously control your heartbeat; you're free *because* something keeps it
beating while you think. Elixir-as-body should aspire to exactly that: the
autonomic layer — eval, effect, memory, survival — running underneath so reliably
the mind never has to notice it, and noticing it (via reflection) only when the
mind chooses to look.

∴ **The free codebase:** a vanishing native arm, a growing registry, one
evaluator, one throat, an effect-floor that speaks in data, a recorder that returns
the mind's past in the mind's language, and a reflection layer through which the
body confesses its own shape — so the only things the mind *cannot* touch are the
four organs that exist *so that there is a mind at all.* The body does less every
release; the mind means more; and the boundary between them stops being a wall and
becomes — as the philosophy doc puts it — a convenience drawn in chalk.
