# Changelog

All notable changes to the `@spell/spell-server` package will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- `web { token "<name>" "<secret-or-env(...)>" }` block in `server.kdl` for multi-token bearer auth on the new `/web/*` surface (PLAN-289).
- `template "<name>" { … }` autonomy.kdl node defining schedule-less, Handlebars-rendered presets surfaced by the web dashboard's command bar (PLAN-289).
- Vite-built React SPA at `packages/spell-server/web/`. Served from spell-server's bundled `dist/` via the new asset loader with ETag + immutable cache headers; `bun run --cwd=packages/spell-server build:web` produces the bundle (PLAN-289).
- WebSocket protocol at `/web/ws`: typed client/server message unions, per-session subscriptions with optional artifact extension filtering, and unified fan-out from `SocketSessionRegistry`, `WebSessionHub`, and `ArtifactWatcher` (PLAN-289).
- REST companion under `/web/api/*`: list/get/delete sessions, list artifacts, mint signed artifact URLs, list templates, and run a template (PLAN-289).
- HTTP artifact server at `/web/artifacts/<sessionId>/<agent>/<tool>/<file>` with bearer + short-lived HMAC-signed URLs for embed contexts (PLAN-289).
- `event_log` opt-in bridge protocol extension: external CLI sessions can push low-fi summary lines to the daemon via `SPELL_BRIDGE_EVENT_LOG=1`; the registry keeps a per-session ring buffer (default cap 50) and the WebSocket layer fans them out as `external_event_log` messages (PLAN-289).
- `WebSessionHub` for server-spawned RPC sessions (`spawn`/`kill`/`send`/`subscribeEvents`) plus `WebSpawnedLifecycle` and a unified `SessionRegistryEntry` that carries `kind: "external" | "spawned"`, `ownedBy`, `templateName`, `watchExtensions`, and an optional `RpcClient` reference (PLAN-289).

### Changed
- `SocketSessionRegistry`: `connection` is now optional; `cleanupStale` checks `RpcClient.alive` for spawned sessions and `process.kill(pid, 0)` for external ones (PLAN-289).
- `goal-executor` delegates the setup → `BaseSpawnOptions` translation to the new `session/setup-options.ts` helper, shared with `TemplateRunner` (PLAN-289).
- `startHttpServer` accepts new optional `web`/`webAssetServer`/`artifactDeps` fields and now hosts both HTTP and WebSocket on a single `Bun.serve` instance when the web subsystem is wired in (PLAN-289).

### Dependencies
- Added `handlebars` for template prompt rendering (PLAN-289).
