# Bug Analysis: Session 14b79dc662a38caa - Silent API Stall & Audit Intercepting Continue

## Executive Summary

Two critical bugs discovered in the coding agent after tool results returned:

1. **Bug 1: Silent API Stall** - No API call sent after tool results, session froze at 90K tokens
2. **Bug 2: Audit Intercepting Continue** - User "continue" command injected plan-audit prompt instead of resuming from pending tool results

Both bugs trace to the `checkAuditPhase()` mechanism and state management in agent-session.ts.

---

## Bug 1: Silent API Stall After Tool Results

### Symptoms
- Timestamp: 10:40:57, session stalls after tool result returned
- No error logged, no retry initiated, no crash
- Agent state shows `isStreaming: false`, but no new API call
- Session hung with 90K tokens on claude-opus-4-6

### Root Cause Chain

**Stall occurs in post-prompt maintenance flow:**

1. **Agent loop ends** (agent-session.ts:897, `agent_end` event)
   - Tool result message received, agent should call API to process it
   - Loop emits `agent_end` event

2. **Post-turn maintenance starts** (agent-session.ts:897-941)
   - Checks for retryable errors → false (no error, tool result is success)
   - Checks for auto-compaction → runs compaction task
   - **After compaction returns**, continues to line 928

3. **Message filtering hides pending state** (agent-session.ts:928-941)
   ```typescript
   const hasToolCalls = msg.content.some(content => content.type === "toolCall");
   if (hasToolCalls) {
       return;  // ← Early exit if msg has tool calls
   }
   // Check for incomplete todos only after a final assistant stop, not intermediate tool-use turns.
   if (msg.stopReason !== "error" && msg.stopReason !== "aborted") {
       if (this.#enforceRewindBeforeYield()) {
           return;
       }
       const todoReminderSent = await this.#checkTodoCompletion();
       if (!todoReminderSent) {
           await this.#checkAuditPhase();  // ← BUT: Audit can inject prompt & call continue()
       }
   }
   ```

4. **Audit phase interference** (agent-session.ts:4197-4256)
   - If `auditState.pending === "auto"` or `"suggest"`:
     - Calls `#injectAuditPrompt()` at line 4214 or 4232
     - Injects developer message (plan-audit.md template)
     - **Calls `#scheduleAgentContinue()`** at line 4255
   - But this scheduled continue may not fire if conditions prevent it

5. **Scheduled continue race condition** (agent-session.ts:1024-1049)
   ```typescript
   #scheduleAgentContinue(options?: { ... }): void {
       this.#schedulePostPromptTask(
           async () => {
               if (options?.shouldContinue && !options.shouldContinue()) {
                   options.onSkip?.();
                   return;
               }
               try {
                   await this.agent.continue();
               } catch {
                   options?.onError?.();
               }
           },
           { delayMs: options?.delayMs, generation: options?.generation, onSkip: options?.onSkip }
       );
   }
   ```
   - Post-prompt task scheduled outside agent_end callback chain
   - If task is aborted or skipped before execution, `continue()` never called
   - Session remains idle with tool results pending in agent.state.messages

### Why Silent?

**Multiple error-swallowing layers:**

1. **schedulePostPromptTask** (agent-session.ts:983-1022)
   - Wraps task in try/catch that swallows errors
   - Line 988: `.catch(() => {})` — silently consumes all errors
   - Error never reaches user or logs

2. **scheduleAgentContinue** (agent-session.ts:1037-1041)
   - Wraps `agent.continue()` in try/catch
   - Only calls `onError?.()` if callback provided
   - No default error handling

3. **No error event emitted**
   - Post-prompt tasks run outside agent_end event chain
   - Errors in scheduled tasks never surface as agent events
   - Session state doesn't transition to error state

### Trigger Condition

The stall occurs when **all of these are true**:

1. Tool result returned successfully (assistant msg with toolResult content)
2. **Audit state is pending** (set to `"auto"` or `"suggest"` during plan-mode exit)
3. Audit phase injects prompt and schedules continue
4. Scheduled continue is cancelled/skipped before execution
5. No further user input triggers agent.continue()

---

## Bug 2: Audit Intercepting Continue/Resume Path

### Symptoms
- User types "continue" (or "c" shortcut) to resume after stall
- System injects plan-audit prompt instead of resuming from pending tool results
- Audit is "pending" state from plan-mode activation, not from fresh audit cycle

### Root Cause

**Audit state not cleared when plan mode exits:**

1. **Plan mode activation** (interactive-mode.ts:796)
   - Sets audit state: `pending: false, active: true`
   - Later transitions to: `pending: "auto"` or `pending: "suggest"`

2. **Plan mode exit** (interactive-mode.ts:1335-1344)
   - Clears plan mode flags but **does not clear auditState**
   - auditState remains in pending state from plan mode

3. **User resumes session** (input-controller.ts:184-190)
   - User types "continue" or "c"
   - Calls `session.prompt("")` with empty text
   - This adds a user message, then calls agent via `#promptAgentWithIdleRetry`

4. **agent.continue() executes** (agent.ts:654-680)
   - Since last message is assistant (with tool results), agent continues
   - **But** before agent loop, agent-session hooks fire

5. **Post-turn maintenance runs for previous turn** (agent-session.ts:897-941)
   - **Audit state is still pending from plan mode exit**
   - `#checkAuditPhase()` is called
   - Since `state.pending !== false`, injects audit prompt
   - Schedules agent.continue() again with audit prompt already injected
   - This continue overrides the user's continue request

### The State Diagram

```
Plan Mode Active → auditState: { pending: "auto", active: false, ... }
                ↓
Plan Mode Exit → auditState UNCHANGED (bug!)
                ↓
User types "continue" → session.prompt("")
                ↓
agent.continue() invoked
                ↓
Post-turn maintenance fires
                ↓
checkAuditPhase() sees pending !== false
                ↓
Injects plan-audit prompt + schedules agent.continue()
                ↓
Audit prompt sent to LLM instead of just tool results
```

### Why This Happens

**Audit state cleanup is incomplete:**

In agent-session.ts line 922, audit state is cleared on error/abort:
```typescript
if (msg.stopReason === "aborted" || msg.stopReason === "error") {
    this.#auditState = { type: "audit", pending: false, active: false };
}
```

But in interactive-mode.ts, when plan mode exits (line 1335-1344), audit state is never cleared:
```typescript
this.session.setAuditState({
    type: "audit",
    pending: false,
    active: false,
    // ← Should reset here, but depends on whether setAuditState was called
});
```

The issue: **If audit state is left in pending state, the next turn's maintenance phase will trigger it.**

---

## Error Handling Chain

### Current Error Flow (Incomplete)

```
agent.prompt() 
  └─ agentLoop() in agent-loop.ts
      └─ streamSimple() call
          └─ Errors caught and converted to errorMessage AssistantMessage
              └─ agent_end event emitted
                  └─ PostTurnMaintenance event listener (agent-session.ts:897)
                      └─ #checkCompaction() task
                      └─ #checkAuditPhase() — ASYNC, scheduled
                      └─ Error swallowed in task.catch()
```

**Problem: Scheduled post-prompt tasks run outside the event chain**
- Errors in scheduled tasks don't emit agent events
- Errors don't surface to session event listeners
- Session state doesn't transition
- No user notification

### Where Errors Are Lost

1. **agent-session.ts:988** (trackPostPromptTask)
   - `.catch(() => {})` swallows all errors

2. **agent-session.ts:1037-1041** (scheduleAgentContinue)
   - try/catch in scheduled task
   - Only calls optional onError callback
   - No fallback error handling

3. **No error_occurred event for post-prompt tasks**
   - Only agent_end and agent_start fire during turn
   - Mid-turn maintenance errors never surface

---

## Retry Policy Analysis

### What Should Retry

**Retryable Errors** (agent-session.ts:4833-4837):
- overloaded, rate limit, usage limit, 429, 500, 502, 503, 504
- service unavailable, server error, internal error
- connection error, unable to connect, fetch failed, retry delay, stream stall

**NOT Retryable**:
- Context overflow (handled by compaction instead)
- Model errors, parsing errors
- User aborts

### How Retry Works

1. **#handleRetryableError()** (agent-session.ts:4894-4987)
   - Checks if error message matches pattern
   - Emits `auto_retry_start` event
   - Removes error message from agent state (keeps in session history)
   - Waits with exponential backoff (base 100ms, 2^(attempt-1))
   - **Schedules agent.continue()** via `#scheduleAgentContinue()`
   - Max retries: 3 (default)

2. **Retry Success Cleanup** (agent-session.ts:821-833)
   - When next assistant message arrives without error
   - Emits `auto_retry_end: { success: true }`
   - Resets `#retryAttempt` to 0

3. **Retry Cancellation** (agent-session.ts:4992-4996)
   - User can call `session.abortRetry()`
   - Aborts sleep, emits failure event, clears promise

### The Bug in Retry Scheduling

**#scheduleAgentContinue() is fire-and-forget:**

```typescript
async #handleRetryableError(message: AssistantMessage): Promise<boolean> {
    // ... setup ...
    this.#scheduleAgentContinue({ delayMs: 1, generation });  // ← Line 4984
    return true;  // Return immediately, task scheduled async
}
```

The function returns `true` (indicating retry was initiated) **before the scheduled task fires**. If the task is cancelled or aborted before `agent.continue()` is called, the retry silently fails.

**In the stall scenario:**
1. Post-compaction, audit phase schedules its own continue
2. If that scheduled task never runs, agent.continue() never fires
3. Session waits indefinitely for user input
4. When user types "continue", it's intercepted by stale audit state

---

## File Locations & Key Functions

### agent-session.ts (packages/coding-agent/src/session/)

| Line | Function | Purpose |
|------|----------|---------|
| 897-941 | Event listener for `agent_end` | Post-turn maintenance |
| 910-914 | Retry check & dispatch | Check for retryable errors |
| 924-926 | Compaction dispatch | Schedule compaction task |
| 928-941 | Todo & audit checks | Check for incomplete todos, trigger audit |
| 938 | `#checkAuditPhase()` call | **BUG: May inject prompt & schedule continue** |
| 983-1022 | `#trackPostPromptTask()` | Error-swallowing task wrapper |
| 1024-1049 | `#scheduleAgentContinue()` | Schedule agent.continue() asynchronously |
| 4197-4256 | `#checkAuditPhase()` | **BUG: Injects audit prompt if pending** |
| 4233-4256 | `#injectAuditPrompt()` | Injects audit prompt + schedules continue |
| 4819-4838 | `#isRetryableError()` | Pattern matching for retryable errors |
| 4894-4987 | `#handleRetryableError()` | Retry logic with exponential backoff |

### agent.ts (packages/agent/src/)

| Line | Function | Purpose |
|------|----------|---------|
| 687-900 | `#runLoop()` | Main agent event loop |
| 866-892 | Error handling in runLoop | Catches errors, creates errorMessage, emits agent_end |
| 785-848 | Event processing | Emits to listeners for each event |

### interactive-mode.ts (packages/coding-agent/src/modes/)

| Line | Function | Purpose |
|------|----------|---------|
| 796 | Audit state set | Plan mode activation |
| 1335-1344 | Audit state management | Plan mode exit (incomplete cleanup) |

### input-controller.ts (packages/coding-agent/src/modes/controllers/)

| Line | Function | Purpose |
|------|----------|---------|
| 184-190 | Continue shortcut handling | "." or "c" triggers empty prompt |
| 341-349 | Input submission | Calls onInputCallback with user input |

### main.ts (packages/coding-agent/src/)

| Line | Function | Purpose |
|------|----------|---------|
| 87-108 | `submitInteractiveInput()` | Submits user input to session.prompt() |
| 101 | `session.prompt()` call | Entry point for user prompts |
| 196-199 | Main input loop | Waits for user input and submits it |

---

## Risk Assessment

### Impact
- **Data Loss**: No immediate data loss (session history preserved)
- **User Confusion**: Silent stalls appear as hung sessions
- **Workaround**: ESC to interrupt, then type message to resume (forces new assistant message)
- **Plan Mode**: Audit mechanism meant for plan verification becomes liability

### Scope
- Affects sessions where:
  - Tool results received successfully
  - Audit state is pending from plan mode
  - User expects to resume with continue command
- Does NOT affect:
  - Sessions without plan mode
  - Sessions with interactive audit approval

### Severity
- **Bug 1 (Stall)**: HIGH — Silent failure, no error message, user-blocking
- **Bug 2 (Audit Intercept)**: HIGH — Unexpected behavior, data flow misdirection

---

## Fix Strategy

### Fix 1: Audit State Cleanup on Plan Mode Exit
**Location**: interactive-mode.ts, plan-mode exit handler
**Change**: Explicitly clear audit state (pending: false) when exiting plan mode
**Rationale**: Prevents stale pending state from intercepting next turn

### Fix 2: Error Visibility for Post-Prompt Tasks
**Location**: agent-session.ts, trackPostPromptTask()
**Change**: Don't swallow errors; emit them as agent events or log them
**Rationale**: Makes retry failures visible to session subscribers

### Fix 3: Scheduled Continue Timeout
**Location**: agent-session.ts, scheduleAgentContinue()
**Change**: Add timeout/deadline for scheduled task execution
**Rationale**: Ensures task fires or fails explicitly, doesn't hang indefinitely

### Fix 4: Separate Audit Phase from Tool Result Processing
**Location**: agent-session.ts, checkAuditPhase()
**Change**: Don't trigger audit immediately after tool results; defer until assistant stop
**Rationale**: Prevents audit from interfering with agent_end → tool result processing flow

---

## Questions for Investigation

1. **Why is auditState pending?** — Was it set during plan-mode initialization and never cleared?
2. **What scheduled task ran?** — Was it compaction, audit injection, or something else?
3. **Did the scheduled continue execute?** — Check agent state for pending tasks
4. **Was there a network error?** — streamSimple timeout, connection reset, etc.?
5. **Did abort/cancellation fire?** — Was post-prompt abort controller triggered?

