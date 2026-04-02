# Spell Server Architecture

Spell Server is a Bun-based daemon that turns a project-local autonomy manifest into scheduled and webhook-triggered agent executions. It is intentionally small in surface area: parse KDL, maintain reusable sessions, schedule work, execute goals with retries and sandbox policies, dispatch result hooks, and expose a dashboard and API over HTTP. Most of the heavy lifting is delegated to existing runtime components rather than reimplemented inside the server.

## Overview

At a high level, Spell Server answers one question: given a repository with a `.spell/` directory, which autonomous goals should run, when should they run, and how should operators observe the result?

The package is structured around a few cooperating subsystems:

- `manifest/` parses and validates `autonomy.kdl` into typed in-memory structures.
- `session/` manages long-lived RPC clients via the internal `rpc/` module.
- `telegram/` contains the Telegram bot, bridge, commands, and log-viewer (merged from the former `telegram-bridge` package).
- `scheduler/` uses Croner to evaluate cron schedules and invoke callbacks.
- `executor/` runs a goal, tracks its state machine, applies retry policy, and writes sandbox policy files.
- `hooks/` delivers run results to webhook, Telegram, or org executors.
- `http/` serves the JSON API, trigger routes, and browser dashboard.

The missing piece is the CLI entrypoint that wires these modules together: load config from `.spell/`, build dependencies, start the HTTP server and scheduler, and handle process shutdown.

## Component Diagram

A text diagram is the easiest way to understand the flow:

1. A project provides `.spell/server.kdl`, `.spell/autonomy.kdl`, and optionally `.spell/channels.kdl`.
2. The startup layer reads those files and builds a `ServerConfig`, an `AutonomyManifest`, and channel integrations.
3. `GoalScheduler` registers every cron-based goal from the manifest.
4. When a cron tick fires, or when `POST /trigger/:id` is called, the scheduler or HTTP route asks `GoalExecutionController` to execute a goal.
5. `GoalExecutionController` resolves the goal’s setup, emits a temporary sandbox policy file if needed, and asks `SessionManager` for an RPC client for that goal.
6. `SessionManager` delegates session creation details to a lifecycle strategy and returns a started `RpcClient`.
7. The executor sends the prompt, collects streamed text into a run summary, enforces timeout and retry logic, and records run history in memory.
8. When execution completes or fails, the executor invokes the hook callback.
9. `HookDispatcher` fans the result out to webhook, Telegram, or org executors.
10. The HTTP API reads state from the manifest, scheduler, and executor to populate the dashboard.

Each subsystem is intentionally narrow. The scheduler does not understand prompts. The hook layer does not know about Croner. The HTTP server does not own execution state; it only queries and triggers it.

## Configuration Files

Spell Server’s configuration model is split across three KDL files because they answer different operational questions.

### `server.kdl`

`server.kdl` is runtime infrastructure config. It answers: on which port should Bun listen, which basic-auth credentials protect `/api/*`, and what shared secrets are available for authenticated webhooks? The server-side HTTP types currently model:

- `port`
- `auth.username`
- `auth.password`
- optional `webhookSecret`
- optional `goalTokens` for bearer-authenticated webhook goals

This file belongs to the deployment environment, not to a single goal.

### `autonomy.kdl`

`autonomy.kdl` is the main manifest. It contains:

- top-level `name` and `version`
- named `setup` blocks for reusable execution policy
- named `goal` blocks for schedule, prompt, hooks, state, and retry behavior

This is the file parsed by `parseManifestKdl()`, validated structurally by TypeScript guards, then semantically by `validateManifest()`.

### `channels.kdl`

`channels.kdl` is optional integration config. In the current design it is the natural place to hold Telegram bot credentials and chat ownership metadata. The hook layer already has Telegram executors and a `NotificationSender` abstraction, so channel config feeds that wiring rather than changing manifest semantics.

## SessionManager and Lifecycle Strategies

`SessionManager<K>` is a generic controller for long-lived RPC sessions. It is parameterized by the logical key type and depends on a `SessionLifecycle<K>` strategy. This is an important design choice: the manager owns concurrency, deduplication, idle timers, and cleanup, while the lifecycle defines how to turn a key into spawn options and how long the session may sit idle.

Important `SessionManager` behaviors:

- `getOrCreate()` deduplicates concurrent requests with a `#pending` map so callers do not create duplicate RPC clients for the same key.
- Existing live sessions are reused and have their idle timer reset.
- `maxSessions` enforces an upper bound across active and pending sessions.
- Per-session event listeners reset idle timers on activity and translate RPC `error` events into lifecycle callbacks.
- `kill()` and `killAll()` dispose clients, remove listeners, clear timers, and optionally invoke lifecycle completion hooks.

Two lifecycle strategies already exist.

`TelegramLifecycle` is optimized for chat sessions. It forwards the provided spawn options and returns a finite idle timeout, defaulting to five minutes. This is appropriate when a chat session should expire after inactivity.

`AutonomyLifecycle` is optimized for daemon-owned goal execution. It never expires sessions due to idle time and automatically injects the `autonomy_state` tool if it is missing from the requested tool list. That matters because stateful goals may need persistent state access even if the manifest’s explicit tool allow-list forgot to include it.

The practical difference is simple: Telegram sessions are conversational and bounded by idle time, while autonomy sessions are goal-centric and durable until the daemon shuts them down.

## Scheduler

`GoalScheduler` wraps Croner and keeps one job record per goal. Each record contains the Cron instance, the schedule entry, a `running` flag, and an optional pending jitter timer.

Key scheduler behaviors:

- `register()` replaces any existing schedule for the same goal name.
- `start()` resumes all registered Cron jobs.
- `stop()` pauses all Cron jobs and clears any pending jitter timers.
- `getNextFireTime()` and `getScheduledGoals()` expose observability data for the HTTP layer.
- Overlap protection is enforced by checking `running` and `pendingJitter` before invoking the callback.

Cron evaluation itself is delegated to Croner. If a goal is configured with jitter, the scheduler computes a random delay from zero to `jitterMs - 1` and defers callback execution by that amount. This is useful when many repositories or many goals would otherwise start at the same exact minute.

The overlap protection is intentionally conservative. If a cron tick happens while the previous run is still executing, the tick is skipped and a warning is logged. That avoids stacked runs and the ambiguity that would come with concurrent mutation of the same repository.

## Executor and State Machine

`GoalExecutionController` is the runtime core. It owns current goal states, per-goal run history, temporary sandbox policy files, and integration callbacks for hooks and escalation.

The externally visible state machine is:

- `pending`
- `running`
- `completed`
- `failed`
- `retrying`
- `escalated`
- `paused`

Execution starts by resolving the goal and its referenced setup from the manifest. A goal already marked `running` is rejected. A goal in `paused` is also rejected; that state means previous retries exhausted and a human should inspect it.

For each attempt, the controller:

1. Transitions state into `running`.
2. Creates a run record with a stable `runId`, timestamps, and attempt number.
3. Writes a temporary sandbox policy file if the setup includes sandbox rules.
4. Obtains a client from `SessionManager` using spawn options derived from the setup.
5. Sends the goal prompt and listens to streamed text deltas to build a summary.
6. Enforces an optional timeout parsed from values like `30m` or `15s`.
7. On success, marks the run completed and emits a success result.
8. On failure, classifies the run, records the error, and either retries or escalates.

Retry behavior defaults to three retries, five seconds initial delay, and a multiplier of two, unless overridden in the manifest. Once retries are exhausted, the controller transitions through `escalated` and then `paused`, logs a warning, invokes the optional escalation callback, and returns a failure result.

The timeout path is notable: the executor races the prompt promise against a timeout promise, kills the session if the timeout wins, and classifies the run status as `timeout`.

## Hooks

`HookDispatcher` accepts a map of hook executors keyed by hook type. Given a `GoalResult` and optional `ManifestHookConfig`, it fires:

- `onSuccess` only for success results
- `onFailure` only for failure results
- `onComplete` for both outcomes

Hook delivery is best effort. Missing executors and per-target failures are logged but do not abort the rest of hook processing.

### Webhook executor

`WebhookHookExecutor` supports `POST` and `GET`, substitutes simple `{{goalName}}`-style templates into the URL, sends a small JSON payload for POST requests, and enforces a five-second timeout. Non-2xx responses are logged as warnings.

### Telegram executor

`TelegramHookExecutor` formats a short multi-line message with goal name, status, duration, and optional error or summary. It depends on a `NotificationSender`; if the sender is a `NoopNotificationSender`, Telegram delivery is silently skipped.

### Org executor

`OrgHookExecutor` currently logs what it would do rather than mutating org files directly. The class is still useful because it establishes the event contract and output shape now, without pretending the org integration is finished.

## HTTP API

The HTTP layer is deliberately small and synchronous in structure.

Routes served today:

- `GET /` and `GET /index.html` for the dashboard
- `GET /api/goals`
- `GET /api/goals/:goalName`
- `GET /api/goals/:goalName/runs`
- `GET /api/goals/:goalName/logs`
- `GET /api/manifest`
- `POST /trigger/:triggerId`

Authentication rules:

- `/api/*` requires HTTP basic auth verified against `ServerConfig.auth`.
- `/trigger/*` is open at the routing layer, but individual webhook goals may require HMAC or bearer authorization according to their manifest schedule.
- CORS headers are added to all responses, including errors and preflight handling.

Trigger routing deserves separate mention. `handleTriggerRoute()` first matches a goal by exact name or by normalized webhook path. It then reads the request body with a one-megabyte limit, applies HMAC or bearer verification when configured, and finally calls `handleTrigger()` to start the goal asynchronously and return HTTP 202.

## Frontend Dashboard

The dashboard is a single HTML asset embedded with Bun’s text import support. It uses import maps to load Preact, Preact hooks, and HTM from `esm.sh`. No separate frontend build step is required.

The UI polls the JSON API every ten seconds, stores `username:password` credentials in `localStorage`, shows manifest metadata, lists goals, and renders per-goal detail including the current config JSON and the most recent run history. The dashboard can also trigger a goal manually by POSTing to `/trigger/:goalName`.

This design keeps operations simple: if the Bun server is up, the dashboard is up.

## Sandbox Enforcement

Sandbox policy lives at the setup level. The manifest parser understands three sandbox controls:

- `paths-write`
- `bash-allow`
- `bash-deny`

When a goal starts, the executor serializes these lists into a temporary JSON file under the system temp directory. The file path is passed as `sandboxPolicyPath` in the RPC spawn options. After the run finishes, the file is removed on a best-effort basis.

The server therefore does not enforce filesystem and command restrictions itself. Instead, it translates declarative KDL policy into the artifact the downstream runtime enforces.

## State and Persistence

The manifest schema supports per-goal state with `state persist=<bool>` and optional typed schema columns. The parser and serializer fully support this shape, and the autonomy lifecycle ensures the `autonomy_state` tool is available to goal sessions.

That means Spell Server’s responsibility is to declare and pass state capability through the runtime contract. The package does not currently open SQLite directly inside `packages/spell-server/src`; persistence is delegated to the underlying autonomy state tool and the wider runtime. When documenting deployments, it is best to think of state as per-goal persisted runtime state whose schema is declared in the manifest, rather than as an HTTP-server-owned database.

## RPC Layer

The `rpc/` module contains `RpcClient`, `RpcSpawnOptions`, and event stream types that form the basis for both session management and prompt execution. These were originally part of the `telegram-bridge` package and are now internal to spell-server.

This reuse matters because it avoids inventing a second process protocol. The same module knows how to spawn, stream updates, emit lifecycle events, and terminate remote clients. Spell Server stays focused on daemon concerns: scheduling, policy, retries, hooks, and observability.
## Graceful Shutdown

The graceful shutdown story is split across explicit primitives rather than hidden in one monolithic server class.

- `startHttpServer()` returns both the Bun server object and a `stop()` function.
- `GoalScheduler.stop()` pauses future cron callbacks and clears pending jitter timers.
- `SessionManager.killAll()` tears down every active RPC session.

Those methods are the correct shutdown sequence for the CLI entrypoint: stop accepting new HTTP traffic, stop future schedules, then terminate active sessions within a bounded timeout. `server.ts` itself does not install signal handlers, so signal wiring belongs in the process entrypoint. That separation is healthy: the library exposes deterministic teardown operations, and the CLI decides how to map `SIGINT` and `SIGTERM` onto them.

In production, the main operational requirement is that shutdown be bounded. A foreground daemon supervised by systemd should stop cleanly when possible but still exit within the service manager’s timeout window.
