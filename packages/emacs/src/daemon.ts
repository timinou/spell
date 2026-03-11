import * as fs from "node:fs/promises";
import * as path from "node:path";
import { isEnoent, logger } from "@oh-my-pi/pi-utils";

// ---------------------------------------------------------------------------
// Public interface
// ---------------------------------------------------------------------------

export interface EmacsSession {
	/** Absolute path to the Unix socket the Emacs MCP server is listening on. */
	socketPath: string;
	/** Send kill-emacs to the daemon and remove the socket. */
	stop(): Promise<void>;
	/** True when the socket file still exists. */
	isAlive(): boolean;
}

/**
 * Start (or return an existing) Emacs daemon for the given project + session.
 *
 * Sessions are identified by `hash(projectRoot + sessionId)`. Two calls with
 * the same inputs return the cached session without launching a second daemon.
 * Different project roots always get separate daemons.
 *
 * @param emacsPath   - Absolute path to the emacs binary.
 * @param projectRoot - Absolute path to the project root (used for hashing).
 * @param sessionId   - Opaque session identifier (e.g. Pi session UUID).
 * @param orgElispDir - Path to packages/org/elisp/ for MCP server infrastructure.
 * @param elispDir    - Path to packages/emacs/elisp/ for pi-emacs tools.
 */
export async function startEmacsSession(
	emacsPath: string,
	projectRoot: string,
	sessionId: string,
	elispDir: string,
): Promise<EmacsSession> {
	const key = sessionKey(projectRoot, sessionId);

	const cached = sessions.get(key);
	if (cached?.isAlive()) {
		logger.debug("[emacs-daemon] Returning cached session", { key, socketPath: cached.socketPath });
		return cached;
	}
	// Stale entry — remove before relaunching.
	if (cached) sessions.delete(key);

	const session = await launchDaemon(emacsPath, projectRoot, sessionId, elispDir, key);
	sessions.set(key, session);
	return session;
}

// ---------------------------------------------------------------------------
// Internal session cache
// ---------------------------------------------------------------------------

/** Module-level cache: sessionKey → live EmacsSession. */
const sessions = new Map<string, EmacsSession>();

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

const POLL_INTERVAL_MS = 500;
// First-run startup compiles all tree-sitter grammars (git clone + cc per language).
// At ~3-5s per grammar × 15 languages = ~75s worst case on a slow connection.
// Subsequent starts use cached .so files and take ~900ms.
const STARTUP_TIMEOUT_MS = 120_000;
const HEALTH_INTERVAL_MS = 5_000;
// Show a first-run warning after this many ms so users know kika is compiling
// tree-sitter grammars rather than hanging.
const FIRST_RUN_WARN_MS = 8_000;

/**
 * Stable hash key derived from projectRoot only.
 *
 * The daemon is shared across all Pi sessions for the same project — using
 * a per-session key would spawn a redundant daemon (and redundant grammar
 * compilation) every time `omp` starts.
 */
function sessionKey(projectRoot: string, _sessionId: string): string {
	const raw = Bun.hash(projectRoot);
	return BigInt(raw).toString(16).slice(0, 12).padStart(12, "0");
}

/** Absolute path to the Unix socket for a given hash key. */
function socketPath(hashHex: string): string {
	const dir = process.env.XDG_RUNTIME_DIR ?? "/tmp";
	return path.join(dir, `omp-emacs-${hashHex}.sock`);
}

/** Returns true when the socket file is present on disk. */
async function socketExists(p: string): Promise<boolean> {
	try {
		await fs.access(p);
		return true;
	} catch (err) {
		if (isEnoent(err)) return false;
		// Permission errors or other unexpected errors: treat as absent to avoid hanging.
		return false;
	}
}

const PROBE_TIMEOUT_MS = 2_000;

/**
 * Attempt a minimal JSON-RPC handshake over the Unix socket to verify the
 * daemon is actually alive and accepting connections. Returns true if the
 * daemon responds within PROBE_TIMEOUT_MS.
 */
async function probeSocket(sock: string): Promise<boolean> {
	const socat = Bun.which("socat");
	if (!socat) return false;

	try {
		// Send a minimal tools/list request. We don't care about the response
		// content — any valid JSON-RPC reply means the daemon is alive.
		const req = JSON.stringify({ jsonrpc: "2.0", id: 0, method: "tools/list", params: {} });
		const proc = Bun.spawn([socat, "STDIO", `UNIX-CONNECT:${sock}`], {
			stdin: "pipe",
			stdout: "pipe",
			stderr: "ignore",
		});
		proc.stdin.write(`${req}\n`);
		proc.stdin.end();

		const exited = await Promise.race([proc.exited, Bun.sleep(PROBE_TIMEOUT_MS).then(() => null as number | null)]);
		if (exited === null) {
			proc.kill();
			return false;
		}
		return exited === 0;
	} catch {
		return false;
	}
}

/**
 * Wrap an already-running daemon socket as an EmacsSession without launching
 * a new process. Sets up the same health-check timer as a fresh launch.
 */
function wrapExistingSocket(sock: string, key: string, daemonName: string): EmacsSession {
	let alive = true;
	const healthTimer = setInterval(async () => {
		if (!(await socketExists(sock))) {
			logger.warn("[emacs-daemon] Socket disappeared — daemon may have crashed", { daemonName, sock });
			alive = false;
			sessions.delete(key);
			clearInterval(healthTimer);
		}
	}, HEALTH_INTERVAL_MS);
	healthTimer.unref();

	return {
		socketPath: sock,
		isAlive: () => alive,
		async stop() {
			clearInterval(healthTimer);
			alive = false;
			sessions.delete(key);
			logger.debug("[emacs-daemon] Stopping daemon", { daemonName });
			try {
				await Bun.$`emacsclient --socket-name=${daemonName} --eval "(kill-emacs)"`.quiet().nothrow();
			} catch (err) {
				logger.warn("[emacs-daemon] emacsclient kill failed", {
					daemonName,
					err: err instanceof Error ? err.message : String(err),
				});
			}
			try {
				await fs.unlink(sock);
			} catch (err) {
				if (!isEnoent(err)) {
					logger.warn("[emacs-daemon] Could not remove socket after stop", { sock });
				}
			}
		},
	};
}

/** Poll until the socket appears or the deadline passes. */
/** Poll until the socket appears or the deadline passes.
 *
 * Emits a one-time progress line to stderr after FIRST_RUN_WARN_MS so users
 * know kika is compiling tree-sitter grammars, not hanging.
 */
async function waitForSocket(p: string, daemonName: string): Promise<void> {
	const start = Date.now();
	const deadline = start + STARTUP_TIMEOUT_MS;
	let warned = false;
	while (Date.now() < deadline) {
		if (await socketExists(p)) return;
		if (!warned && Date.now() - start >= FIRST_RUN_WARN_MS) {
			warned = true;
			process.stderr.write(
				`  Emacs (${daemonName}): installing tree-sitter grammars on first run, may take ~60s...\n`,
			);
		}
		await Bun.sleep(POLL_INTERVAL_MS);
	}
	throw new Error(`Emacs daemon did not create socket within ${STARTUP_TIMEOUT_MS}ms: ${p}`);
}

async function launchDaemon(
	emacsPath: string,
	projectRoot: string,
	_sessionId: string,
	elispDir: string,
	key: string,
): Promise<EmacsSession> {
	const daemonName = `omp-emacs-${key}`;
	const sock = socketPath(key);

	// Check whether a daemon from a previous omp session left a live socket.
	// If so, skip launching entirely — reuse the existing daemon.
	if (await socketExists(sock)) {
		if (await probeSocket(sock)) {
			logger.debug("[emacs-daemon] Reusing existing daemon", { daemonName, sock });
			return wrapExistingSocket(sock, key, daemonName);
		}
		// Socket exists but daemon is dead — clean up.
		logger.debug("[emacs-daemon] Removing stale socket from previous session", { sock });
		try {
			await fs.unlink(sock);
		} catch (err) {
			if (!isEnoent(err)) {
				logger.warn("[emacs-daemon] Could not remove stale socket", { sock, err: String(err) });
			}
		}
	}

	// -Q skips the user's init file and all site files.
	// pi-prelude.el bootstraps tree-sitter grammars into Pi's own directory,
	// compiling any that are missing (first run only, then instant).
	// pi-emacs-mcp.el is self-contained: it vendors the MCP infrastructure.
	const args = [
		"-Q",
		`--daemon=${daemonName}`,
		"--eval",
		`(add-to-list 'load-path "${elispDir}")`,
		"--eval",
		// pi-project-root is read by pi-prelude to locate per-project treesitter.json.
		`(setq pi-project-root "${projectRoot}")`,
		"--eval",
		`(require 'pi-prelude)`,
		"--eval",
		`(require 'pi-emacs-mcp)`,
		"--eval",
		`(mcp-server-start-unix nil "${sock}")`,
	];

	logger.debug("[emacs-daemon] Spawning daemon", { daemonName, sock, elispDir });

	// Detached: the child outlives the parent process.
	// Pipe stderr so grammar compilation progress is forwarded to the Pi log.
	const proc = Bun.spawn([emacsPath, ...args], {
		stdio: ["ignore", "ignore", "pipe"],
		detached: true,
	});
	// Consume stderr in a background task — logs each line, never blocks process exit.
	if (proc.stderr) {
		(async () => {
			const decoder = new TextDecoder();
			for await (const chunk of proc.stderr as ReadableStream<Uint8Array>) {
				for (const line of decoder.decode(chunk).split("\n")) {
					if (line.trim()) logger.debug(`[emacs-daemon] ${line.trim()}`, { daemonName });
				}
			}
		})().catch(() => {});
	}
	// Detach Bun's reference so it doesn't block process exit.
	proc.unref();

	// Wait for the daemon to signal readiness by writing the socket.
	try {
		await waitForSocket(sock, daemonName);
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		logger.error("[emacs-daemon] Daemon startup timed out", { daemonName, sock, err: msg });
		throw err;
	}

	logger.debug("[emacs-daemon] Daemon ready", { daemonName, sock });

	// Health-check timer: if the socket disappears, evict the session from cache.
	let alive = true;
	const healthTimer = setInterval(async () => {
		if (!(await socketExists(sock))) {
			logger.warn("[emacs-daemon] Socket disappeared — daemon may have crashed", { daemonName, sock });
			alive = false;
			sessions.delete(key);
			clearInterval(healthTimer);
		}
	}, HEALTH_INTERVAL_MS);
	// Do not let the timer block process exit.
	healthTimer.unref();

	return {
		socketPath: sock,

		isAlive(): boolean {
			return alive;
		},

		async stop(): Promise<void> {
			clearInterval(healthTimer);
			alive = false;
			sessions.delete(key);

			logger.debug("[emacs-daemon] Stopping daemon", { daemonName });

			// Ask emacs to shut itself down gracefully.
			try {
				await Bun.$`emacsclient --socket-name=${daemonName} --eval "(kill-emacs)"`.quiet().nothrow();
			} catch (err) {
				logger.warn("[emacs-daemon] emacsclient kill failed", {
					daemonName,
					err: err instanceof Error ? err.message : String(err),
				});
			}

			// Remove socket file if still present.
			try {
				await fs.unlink(sock);
			} catch (err) {
				if (!isEnoent(err)) {
					logger.warn("[emacs-daemon] Could not remove socket after stop", { sock });
				}
			}
		},
	};
}
