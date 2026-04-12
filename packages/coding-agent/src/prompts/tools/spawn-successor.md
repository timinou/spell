Adds a successor node to the live swarm DAG and returns the new node URI.

Use when the current agent needs to extend the work graph rather than transfer control.
- `slug` is required and becomes the successor node identifier.
- `deps` is optional. When omitted, the new node depends on the current task. When empty, the new node starts immediately.
- Dependencies must resolve to existing DAG nodes; cycles and missing nodes are rejected by the scheduler.
- Outside swarm mode the tool fails truthfully instead of pretending the DAG changed.