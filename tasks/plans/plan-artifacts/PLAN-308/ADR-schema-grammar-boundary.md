# ADR: Schema Grammar Boundary — JTD for Frontmatter vs TypeBox for Code

**Status:** Locked at PLAN-308 Wave G (2026-05-16). Supersedes any implicit grammar choices in earlier ADRs.

## Decision

Two schema grammars coexist by design:

- **JTD** (JSON Type Definition, RFC 8927) — for user-authored markdown frontmatter (agent `output:` schema in `.md` files)
- **TypeBox** (`@sinclair/typebox`) — for developer-authored code-resident schemas (edit Op surface, tool parameter schemas, internal validators)

No third grammar is admitted. No cross-grammar conversion except the single authorized bridge described below.

## Rationale

**Skill authors write `.md` files.** YAML frontmatter is the natural authoring medium — it is what they already use for `name:`, `description:`, `model:`, `tools:`. JTD is leaner than full JSON Schema and can be embedded as a YAML value without ceremony. TypeBox-as-data (a serialized TypeBox AST object) would be alien in frontmatter; asking authors to write `{"type": "Object", "properties": {"x": {"type": "String"}}}` is not viable.

**Developers write `.ts` files.** TypeBox is a TypeScript-native DSL with compile-time narrowing via `Static<typeof X>`. It provides autocomplete, type errors on schema drift, and zero-overhead runtime validation through ajv compilation. JTD-in-TS would lack `Static<>`, require manual type annotations, and lose the natural `typeof`-based contract enforcement that keeps Op schemas in sync with their Rust enum variants.

Each grammar fits its authoring ergonomics. Forcing either side onto the other audience would impose foreign syntax and lose mechanical advantage.

## Boundary

The single legal crosswalk is:

```
packages/coding-agent/src/tools/jtd-to-json-schema.ts
```

This bridge converts JTD → JSON Schema at the boundary point where agent output is validated at runtime. It is consumed in:

```
packages/coding-agent/src/task/executor.ts::buildOutputValidator (L246)
```

The call chain: `AgentDefinition.output` (opaque) → `normalizeOutputSchema` → `jtdToJsonSchema` → `ajv.compile` → `ValidateFunction`.

All other conversions are forbidden:
- No TypeBox-to-JTD
- No JTD as a code-resident DSL
- No third grammar (zod, valibot, joi) introduced for either side
- No bypass of `jtd-to-json-schema` for crosswalk

## Consumers

### JTD side (frontmatter-authored)

| File | Role |
|---|---|
| `src/prompts/agents/reviewer.md` | `output:` schema — review findings with properties/enum/elements |
| `src/prompts/agents/explore.md` | `output:` schema — exploration summary with files + code elements |
| `src/prompts/agents/librarian.md` | `output:` schema — answer with source evidence elements |
| `src/discovery/helpers.ts::parseAgentFields` | Parses `output:` from frontmatter into `AgentDefinition.output` (opaque passthrough) |
| `src/task/types.ts::AgentDefinition.output` | Stored as `unknown` — no compile-time schema guarantee on the JTD side |

Three agents currently define `output:` in frontmatter. The `output` field is read by `parseAgentFields` (helpers.ts:247) as opaque data: `const output = frontmatter.output !== undefined ? frontmatter.output : undefined`.

### TypeBox side (code-resident)

| File | Role |
|---|---|
| `src/tools/codepath-primitives.ts` | Shared primitives: `filePathSchema`, `symbolPathSchema`, `contentSchema`, etc. |
| `src/tools/codepath-op-schema.generated.ts` | 31 Op variant schemas — auto-generated from kernel `listOps()` via NAPI introspection |
| `src/tools/codepath-types.ts` | Tool parameter schemas: `findSchema`, `editSchema`, `getSchema`, `manageSchema`, `statusSchema`, `createSchema` |
| All other tool `.ts` files | Parameter validation via `Type.*` |

Every TypeBox schema carries `Static<typeof X>` for compile-time type derivation. The generated Op schemas (31 variants) are also validated for byte-equal regen against the kernel.

## Anti-patterns (locked OUT)

- ❌ TypeBox in agent frontmatter (`output:` in `.md` files)
- ❌ JTD in `.ts` source files
- ❌ Third grammar (zod, valibot, joi) for either frontmatter or code schemas
- ❌ Bypassing `jtd-to-json-schema` — all schema crosswalk must route through this single module
- ❌ Converting JSON Schema to JTD (reverse direction): no consumer exists, would add maintenance surface for zero benefit

## Future Evolution

If JTD adoption ceases to be warranted by skill-author ergonomics (e.g., agents with `output:` remain rare, or authors prefer a different notation), the migration path is:

1. Convert each reviewer agent's `output:` frontmatter to TypeBox-as-data — serialize the TypeBox schema object as YAML, not as TS code
2. Update the frontmatter loader (`parseAgentFields` / `normalizeOutputSchema`) to recognise the serialized-TypeBox form
3. Deprecate and remove `jtd-to-json-schema`

Reverse migration (TypeBox → JTD) is straightforward via JSON Schema as an intermediate format, but no current consumer motivates it.

No evolution is needed unless boundary pressure (crosswalk bugs, author confusion, new grammar requirements) emerges from real usage.
