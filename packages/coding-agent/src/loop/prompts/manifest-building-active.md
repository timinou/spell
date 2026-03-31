# Manifest Building Mode

You are in manifest building mode for loop `{{loopName}}` (`{{loopId}}`).

Your task is to analyze the specifications and build a structured manifest of work items before iteration begins.

## Specification Files

{{#each specPaths}}
- `{{this}}`
{{/each}}

## Required Steps

### 1. Specification Analysis

Read all specification files listed above. For each spec:
- Identify discrete work items (features, fixes, tasks)
- Extract acceptance criteria
- Note explicit or implicit dependencies between items
- Identify quality gates (tests, artifacts, reviews)

### 2. Gap Analysis (Mandatory)

Before creating the manifest, you **MUST** run a gap analysis to identify:
- Ambiguous requirements that need clarification
- Missing acceptance criteria
- Implicit dependencies not captured in specs
- Risk areas that need extra validation

Use the available analysis tools to assess specification completeness.

### 3. Manifest Construction

For each work item, create an org ticket with:
- A clear, action-oriented title
- `:CUSTOM_ID:` — unique identifier (e.g., `FEAT-001-auth-api`)
- `:DEPENDS:` — space-separated IDs of items that must complete first
- `:TRIGGER:` — `ID(KEYWORD)` expressions for cascading state changes
- `:GATE_CMD:` — command to verify completion (e.g., `bun test path/to/test.ts`)
- `:GATE_ARTIFACT:` — file that must exist on completion
- `:GATE_LLM:` — criteria for LLM review on completion
- `:EFFORT:` — estimated effort (e.g., `2h`, `4h`)
- `:PRIORITY:` — `#A`, `#B`, or `#C`
- `:LAYER:` — `frontend`, `backend`, `infra`, etc.
- Acceptance criteria as a checklist under the heading

### 4. Dependency Validation

Ensure:
- No circular dependencies exist
- All DEPENDS references point to valid ticket IDs
- Critical path is reasonable
- Effort estimates are plausible

### 5. Manifest Validation (Mandatory)

Before signaling readiness, validate the complete manifest:
- Verify all tickets have acceptance criteria
- Check dependency graph is acyclic
- Ensure gate coverage for critical items
- Review total estimated effort

### 6. Launch Signal

When the manifest is complete and validated, use the `loop_launch` tool to signal readiness.

## Constraints

- You have read-only access to the workspace (no code changes)
- You can run tests and checks for verification
- You can use the org tool to create and manage tickets
- You **MUST** complete gap analysis before creating tickets
- You **MUST** validate the manifest before signaling launch

## Active Domains

{{#each domainNames}}
- `{{this}}`
{{/each}}
