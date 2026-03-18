# Canvas Component Gap Analysis

## Current Inventory
Current `AgentCanvas` block inventory:
- `markdown`
- `image`
- `table`
- `diff`
- `tree`

Supporting behavior exists for prompts and unknown-type fallback rendering.

## Gaps Identified from Reference Canvases

### 1) Layout Container
`AgentCanvas` currently renders blocks in a vertical `ColumnLayout` only.

**Gap:** dashboard and code-review surfaces need side-by-side composition (`row`, `grid`, nested layout regions).

**Impact:** without a layout container, canvases are constrained to vertical stacking and cannot express richer 2D layouts.

### 2) Status Indicator
Agent workflows need compact state visibility (idle/thinking/working/blocked).

**Gap:** existing block types are too heavy for a lightweight status signal.

**Impact:** Agent Monitor and meta-interface dashboard cannot present at-a-glance status efficiently.

### 3) Log Stream / Append-Only Text
Streaming output and logs require incremental rendering.

**Gap:** `markdown` updates replace/re-render full text payloads.

**Impact:** inefficient for high-frequency append patterns, and harder to maintain smooth tail-follow UX.

### 4) Progress Bar
Long-running operations need explicit progress feedback.

**Gap:** no dedicated progress component with determinate and indeterminate modes.

**Impact:** users cannot reliably track operation state from tool-driven percentage updates.

### 5) Code Block (Syntax Highlighted)
Code-review flows need readable syntax-aware code presentation.

**Gap:** markdown code rendering is basic and does not provide true syntax highlighting.

**Impact:** reduced readability and higher review friction for code-heavy canvases.

## Priority
1. **Layout container** (highest; blocks dashboard layout entirely)
2. **Status indicator**
3. **Log stream / append-only text**
4. Progress bar
5. Syntax-highlighted code block

## Recommendation for PROJ-B
Implement the following three components within current scope cap:
- Layout container
- Status indicator
- Log stream / append-only text
