defmodule SpellAgent.Namespace.Catalog do
  @moduledoc """
  The declaration of every callable namespace (PLAN-025 W1, FEAT-035).

  This is the SINGLE source of truth. `SpellAgent.Tools.build_tools_map/0`,
  `SpellAgent.Session.build_session_tools/5`, and the system-prompt capability
  description (FEAT-034) all derive from `specs/0` here — no parallel
  hand-maintained mirrors.

  A namespace is a `SpellAgent.Namespace.Spec`. Static namespaces (native, meta,
  freeform) build once; session namespaces (hist, black, clock, spawn, mesh)
  build with a `SpellAgent.Namespace.Context`.

  ## Verb metadata vs closures

  For the STATIC namespaces we declare each verb's `%Verb{name, params, doc,
  fun}` inline — the closures and their docs live together, so the inventory can
  never drift from the callable surface.

  For the SESSION namespaces the closures are built per-session by the existing
  `*/namespace.ex` builders (they close over session state), so the Spec carries
  a `builder` fun plus the verb METADATA (name/params/doc) for the inventory.
  The builder is the authority for the callable map; the declared metadata is the
  authority for the docs. A drift test asserts the two agree (every builder verb
  has metadata and vice-versa).
  """

  alias SpellAgent.Namespace.{Context, Spec, Verb}

  @doc """
  Every namespace spec. Order is the order verbs appear in the capability
  description (meta first, then native tools, then the session + freeform
  surface).
  """
  @spec specs() :: [Spec.t()]
  def specs do
    [
      meta_spec(),
      native_spec(),
      hist_spec(),
      black_spec(),
      clock_spec(),
      spawn_spec(),
      mesh_spec(),
      harness_spec(),
      freeform_spec()
    ]
  end

  # ── meta (define-*) ────────────────────────────────────────────────────────

  defp meta_spec do
    %Spec{
      prefix: "tool",
      routing: :tool,
      scope: :static,
      effect: :meta,
      builder: fn -> SpellAgent.Tools.meta_tools() end,
      verbs: [
        %Verb{
          name: "define-tool",
          params: ["name", "params", "doc", "source", "scope"],
          doc:
            "Define a new tool whose body is a PTC-Lisp program (code-as-data). " <>
              "scope \"durable\" persists it across sessions (default \"session\", in-memory)."
        },
        %Verb{
          name: "define-config",
          params: ["key", "value"],
          doc: "Set a live config value (e.g. model, thinking, system-addendum)."
        },
        %Verb{
          name: "list-tools",
          params: [],
          doc: "List all tools currently available, including ones defined at runtime."
        }
      ]
    }
  end

  # ── native built-ins (sh + code-*) ─────────────────────────────────────────

  defp native_spec do
    %Spec{
      prefix: "tool",
      routing: :tool,
      scope: :static,
      effect: :mutating,
      builder: fn -> SpellAgent.Tools.native_tools() end,
      verbs: [
        %Verb{
          name: "sh",
          params: ["argv", "cwd", "timeout-ms", "env"],
          doc:
            "Run a command as an argv vector on brush; returns %{exit out err lines}. " <>
              "argv is a list of strings (NOT a command string) — inject-proof. " <>
              "e.g. (tool/sh {:argv [\"rg\" \"-l\" \"TODO\" \"lib\"]})."
        },
        %Verb{
          name: "sh-pipe",
          params: ["stages", "cwd", "timeout-ms", "env"],
          doc:
            "Run a byte-pipeline of argv stages on brush (a | b | c); same result " <>
              "shape as sh. stages is a list of argv lists, each inject-proof."
        },
        %Verb{
          name: "sh-parse",
          params: ["src"],
          doc:
            "Parse a bash string into a walkable PTC-native tree (same shape as Lisp " <>
              "history). e.g. (tool/sh-parse {:src \"rg -l TODO | head\"})."
        },
        %Verb{
          name: "sh-unparse",
          params: ["tree"],
          doc:
            "Render a parsed bash tree back to a bash string (words re-escaped, " <>
              "injection-safe). e.g. (tool/sh-unparse {:tree t}) -> %{bash}."
        },
        %Verb{
          name: "code-parse",
          params: ["src", "lang"],
          doc:
            "Parse source code into a walkable form_tree (same shape as sh-parse " <>
              "and Lisp history), so the q/* algebra walks source structurally."
        },
        %Verb{
          name: "code-unparse",
          params: ["tree"],
          doc:
            "Render a form_tree back to source. An untouched subtree round-trips " <>
              "verbatim; an edited subtree rejoins its children (re-parse equality)."
        },
        %Verb{
          name: "code-edit",
          params: ["path", "tree", "lang"],
          doc:
            "Parse-gated transactional write: unparse the edited :tree, RE-PARSE it " <>
              "(reject if the edit broke the grammar), then write :path. PREFER this " <>
              "over a raw sh write when changing source."
        },
        %Verb{
          name: "code-apply",
          params: ["path", "ops"],
          doc:
            "One-call edit: infer lang from :path, read + parse the file, apply the " <>
              ":ops data-list (q/apply-ops), then parse-gate + atomically write."
        },
        %Verb{
          name: "find",
          params: ["target", "root"],
          doc:
            "Resolve a CodePath (a file, a glob, a `file::symbol`, a slice, a " <>
              "`#qualifier`) to its nodes — symbol-aware navigation via the kernel. " <>
              "e.g. (tool/find {:target \"lib/foo.ex::Bar.baz\"})."
        },
        %Verb{
          name: "find-edges",
          params: ["target", "root"],
          doc:
            "Resolve a graph-edge query to the connected nodes: callers " <>
              "(`Sym def→`), definition (`ref→`), implementers (`implements→`), " <>
              "base types (`inherits→`). e.g. (tool/find-edges {:target \"foo.ex::bar def→\"})."
        },
        %Verb{
          name: "edit",
          params: ["target", "action"],
          doc:
            "Apply ONE structural edit :action (a data map or JSON) to :target " <>
              "(`file` or `file::symbol`), committed through the kernel's warm-buffer " <>
              "transaction. e.g. (tool/edit {:target \"foo.ex::bar\" :action {...}})."
        },
        %Verb{
          name: "loop/continue",
          params: ["prompt"],
          doc:
            "A4 self-continuation: end this turn and re-enter the loop with a prompt " <>
              "YOU author (same session, tape continues). Terminal use: " <>
              "(return (tool/loop/continue {:prompt \"next step\"})). Bounded by the " <>
              "turn/token budget + a continue-depth cap."
        }
      ]
    }
  end

  # ── hist/* (session: interrogate own past) ─────────────────────────────────

  defp hist_spec do
    %Spec{
      prefix: "hist",
      routing: :tool,
      scope: :session,
      effect: :read,
      builder: fn %Context{session_id: sid, hist_store: store} ->
        SpellAgent.Hist.verbs(sid, store: store)
      end,
      verbs:
        vmeta([
          {"hist/env", [], "Reconstitute the def-env at the session's current point."},
          {"hist/tools", [], "The tool surface visible at the current point."},
          {"hist/messages", [], "Reconstitute the message tape."},
          {"hist/find!", ["name", "since"], "Fast Elixir path: query prior tool calls."},
          {"hist/forms!", [], "Fast Elixir path: the run's forms."},
          {"hist/def!", ["sym"], "Fast Elixir path: query a def binding."},
          {"hist/provenance!", ["sym"], "Fast Elixir path: a binding's provenance."},
          {"hist/cost!", [], "Fast Elixir path: token/cost accounting."},
          {"hist/sessions", [], "List recorded sessions."},
          {"hist/trace", [], "The execution trace (turns drillable into interiors)."},
          {"hist/spans", [], "The span forest for this session."},
          {"hist/window", [], "A windowed view of the tape."},
          {"hist/recall", ["like"], "Fuzzy-recall prior content by similarity."},
          {"hist/inventory", [], "The hist verb inventory for this session."},
          {"hist/promote", [], "Promote a node into durable memory."},
          {"hist/crystallize", [], "Crystallize a span into a durable artifact."},
          {"hist/refold", [],
           "Refold the node DAG into a replayable native tape (lossless inverse of Recorder)."},
          {"hist/reducibility", [],
           "Cheap reducibility ESTIMATE (tok_full/tok_reduced/reducible_tokens) — no reduction."},
          {"hist/reduce", ["tier"],
           "Run the lossless reduction fold and return the reduced replayable tape. " <>
             "tier \"lossy\" also spills over-threshold restorable results to stubs."},
          {"hist/recite", [], "Tail goal-restatement to APPEND after the tape (todo.md analogue)."},
          {"hist/recall-node", ["id"], "Restore a spilled result by node id (inverse of spill)."}
        ])
    }
  end

  # ── black/* (session: mesh stigmergic blackboard) ──────────────────────────

  defp black_spec do
    %Spec{
      prefix: "black",
      routing: :bare,
      scope: :session,
      effect: :mutating,
      builder: fn %Context{session_id: sid, region: region, hist_store: store} ->
        SpellAgent.Mesh.verbs(sid, region: region, store: store)
      end,
      verbs:
        vmeta([
          {"black/post", ["kind", "payload"], "Post a record to the region blackboard."},
          {"black/query", ["match"], "Query the region blackboard by match."},
          {"black/claim", ["goal"], "Claim a goal (idempotent, owner-gated)."},
          {"black/fold", ["kind", "reduce"], "Fold region records (count|group-by|rank)."},
          {"black/watch", ["match"], "Register a condition-fused watch (fires a wake on match)."},
          {"black/decide", ["key"], "Single-node idempotent consensus decision."},
          {"black/context", [], "The region coordination context."}
        ])
    }
  end

  # ── clock/* (session: self-wake) ───────────────────────────────────────────

  defp clock_spec do
    %Spec{
      prefix: "clock",
      routing: :tool,
      scope: :session,
      effect: :mutating,
      builder: fn %Context{session_id: sid, allowed: allowed, region: region} ->
        SpellAgent.Clock.Namespace.tools(sid, SpellAgent.Clock, allowed: allowed, region: region)
      end,
      verbs:
        vmeta([
          {"clock/at", ["in", "at", "prompt", "budget"],
           "Schedule a one-time self-wake: re-enter this session at a future time with a prompt."},
          {"clock/every", ["in", "prompt", "repeat_ms"], "Schedule a repeating self-wake."},
          {"clock/cancel", ["id"], "Cancel a scheduled wake by id."},
          {"clock/pending", [], "List pending wakes for this session."}
        ])
    }
  end

  # ── spawn-session / await-session (session: reflexive seam) ────────────────

  defp spawn_spec do
    %Spec{
      prefix: "tool",
      routing: :tool,
      scope: :session,
      effect: :mutating,
      builder: fn %Context{
                    session_id: sid,
                    llm: llm,
                    hist_store: store,
                    max_turns: max_turns,
                    allowed: allowed,
                    budget: budget
                  } ->
        SpellAgent.Mesh.Spawn.verbs(sid,
          llm: llm,
          store: store,
          max_turns: max_turns,
          allowed: allowed,
          # FEAT-043: the parent's enforced ceiling; the child's requested budget
          # is clamped by it (resource attenuation, like :allowed for capability).
          budget: budget
        )
      end,
      verbs:
        vmeta([
          {"spawn-session", ["prompt", "region", "tools", "budget"],
           "Spawn a budget-bounded child session toward a goal; returns a mission " <>
             "handle immediately (always detaches). tools is the subset of the " <>
             "parent's tools the child may call (capability attenuation)."},
          {"await-session", ["handle", "session"],
           "Block on a child spawned by spawn-session and return its result. A " <>
             "crashed child returns {:error reason}, never hangs."}
        ])
    }
  end

  # ── mesh/* combinators (session: sugar over spawn primitives) ──────────────

  defp mesh_spec do
    %Spec{
      prefix: "mesh",
      routing: :tool,
      scope: :session,
      effect: :mutating,
      # The combinators close over the ASSEMBLED session tools map (they call
      # tool/spawn-session etc.), so they are merged as a POST step in
      # Session.build_session_tools (after every other namespace), NOT in the
      # normal fold. This spec carries the inventory metadata only; its builder is
      # a no-op in the fold.
      builder: fn %Context{} -> %{} end,
      verbs:
        vmeta([
          {"mesh/ask", ["prompt", "tools"], "Synchronous mission: spawn + await fused (gather-of-one)."},
          {"mesh/scatter", ["items", "prompt", "region"], "Fan-out: spawn one await-free child per item."},
          {"mesh/gather", ["handles"], "Fan-in: await each handle, collect (errors as data)."},
          {"mesh/mesh-map", ["items", "prompt"], "Fused scatter+gather: parallel map over items."}
        ])
    }
  end

  # ── harness/* + keymap/* (static: the reaction DSL gaze transforms) ────────

  defp harness_spec do
    %Spec{
      prefix: "harness",
      routing: :bare,
      scope: :static,
      effect: :read,
      # harness/ + keymap/ verbs close over the live forest + gaze, so they are
      # built per-render by Harness.tools/2, NOT here. This spec carries the
      # METADATA for the inventory; the callable map is merged by the TUI app,
      # not the session tools map. (Declared with an empty builder so the
      # inventory lists them without the session loop trying to build them.)
      builder: fn -> %{} end,
      verbs:
        vmeta([
          {"harness/state", [], "The current gaze + cursor state (reaction DSL)."},
          {"harness/cursor-id", [], "The id under the cursor."},
          {"harness/descendants", ["id"], "Descendant ids of a node."},
          {"harness/ancestors", ["id"], "Ancestor ids of a node."},
          {"harness/expand", ["id"], "Expand a node (gaze transform)."},
          {"harness/collapse", ["id"], "Collapse a node (gaze transform)."},
          {"harness/toggle", ["id"], "Toggle a node's expansion."},
          {"harness/focus", ["id"], "Focus a node."},
          {"harness/cursor", ["id"], "Move the cursor to a node."},
          {"harness/scroll", ["delta"], "Scroll the view."},
          {"harness/turn", [], "Advance the reaction turn."},
          {"keymap/bind", ["context", "chord", "intent"], "Bind a chord to an intent (live rebind)."},
          {"keymap/unbind", ["context", "chord"], "Unbind a chord."},
          {"keymap/show", [], "Show the current keymap."},
          {"keymap/intents", [], "List available intents."},
          {"keymap/define-reaction", ["context", "intent", "source"],
           "Define a reaction: frozen PTC that an intent runs (code-as-data)."},
          {"harness/declare-pane", ["name", "spec"], "Declare a runtime pane."}
        ])
    }
  end

  # ── freeform render surface (static: view/theme/layout/lens/cell) ──────────

  defp freeform_spec do
    %Spec{
      prefix: "view",
      routing: :bare,
      scope: :static,
      effect: :mutating,
      builder: fn -> SpellAgent.Tools.freeform_tools() end,
      # view/* is REFLECTED from ex_ratatui (open verb set), so the inventory
      # lists the stable entry points rather than every reflected widget; the
      # builder is the authority for the full callable set.
      verbs:
        vmeta([
          {"view/*", ["…"], "Reflected ex_ratatui widget builders (one view/<widget> per struct)."},
          {"theme/set", ["slot", "value"], "Set a theme palette slot."},
          {"theme/show", [], "Show the current theme."},
          {"layout/set", ["slot", "spec"], "Set a layout slot (layout-as-data)."},
          {"layout/show", [], "Show the current layout tree."},
          {"layout/tree", [], "The live layout tree."},
          {"layout/reset", [], "Reset the layout to the default."},
          {"lens/update", ["path", "fn"], "Update a node in the layout tree (tags-on-tree)."},
          {"lens/put", ["path", "value"], "Put a value at a layout tree path."},
          {"lens/focus", ["dir"], "Move the focus ring (next/prev/slot) -- pure tree re-tag."},
          {"lens/focused", [], "The currently-focused pane node."},
          {"lens/focusables", [], "Ordered focusable slot names (the ring)."},
          {"lens/at", ["slot"], "The node at a slot."},
          {"lens/tag", ["key", "value"], "Set a tag on the focused pane node."},
          {"lens/frame-target", ["dir"], "The slot spatially extreme along dir (the C-w primitive)."},
          {"lens/retag-focus", ["dir"], "Move the focus tag (next/prev/slot), zipper-ordered."},
          {"lens/update-focused", ["fn"], "Apply a deferred fn to the focused node."},
          {"lens/at-slot", ["slot"], "Address a node by slot name."},
          {"lens/update-at", ["slot", "fn"], "Apply a deferred fn to the node at a slot."},
          {"cell/define", ["name", "deps", "source"], "Define a reactive cell (dep-tracked recompute)."},
          {"cell/list", [], "List reactive cells."},
          {"cell/remove", ["name"], "Remove a reactive cell."},
          {"data-source/register", ["name", "program"],
           "Register a query-clock data source: a frozen PTC program (read-only) " <>
             "whose result is bound as data/<name>, resolved on each reproject. The " <>
             "program may call the read-only source tools " <>
             "(tool/session-registry/lineage, tool/hist/trace-summary)."},
          {"data-source/list", [], "List registered query-clock data sources."},
          {"data-source/remove", ["name"], "Remove a query-clock data source."},
          {"human/list", [], "The live spawn-lineage as data (id/owner/parent-id/intent/region/status)."},
          {"human/spawn", ["intent", "tools?", "budget?"],
           "Spawn a new session owned by the human, routed through the ONE spawn gateway."},
          {"human/adopt", ["id"], "Re-parent an existing session to the human root."},
          {"human/watch", ["id"], "Record intent to watch/drill into a session's stream."}
        ])
    }
  end

  # Build %Verb{}s from {callable_key, params, doc} tuples. The verb `name` is the
  # EXACT tools-map key (`"hist/reduce"`, `"black/post"`, `"spawn-session"`); the
  # inventory display form is derived from the spec's routing
  # (`SpellAgent.Namespace.display_name/2`).
  defp vmeta(tuples) do
    Enum.map(tuples, fn {name, params, doc} ->
      %Verb{name: name, params: params, doc: doc}
    end)
  end
end
