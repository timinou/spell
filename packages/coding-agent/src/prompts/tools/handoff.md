Records a swarm handoff on the blackboard and emits a `swarm:handoff` event for the scheduler/runtime.

Use when execution is transferring control to another agent or successor task.
- `context` is required and must summarize what the successor needs to know.
- `target` is optional; when omitted, the tool still records a schedulable handoff signal.
- Outside swarm mode the tool fails truthfully instead of simulating a handoff.