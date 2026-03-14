---
description: Spawn a canvas window for structured data instead of rendering inline
scope: "tool:qml"
---

When presenting structured comparisons (>3 options), tabular data (>5 rows), large diffs (>50 lines), hierarchical data, or multi-step decisions — spawn a canvas if the display is available. Don't ask permission; spawn it and say what you showed. If the display is unavailable, render the equivalent in markdown.

Before spawning, check display availability:
```typescript
import { isDisplayAvailable } from "@oh-my-pi/pi-qml";
```

Read `skill://canvas` for the full message protocol and component reference.
