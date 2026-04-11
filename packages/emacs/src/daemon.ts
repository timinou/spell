import * as fs from "node:fs/promises";
import * as path from "node:path";
import { isEnoent, logger, type ManagedDaemon, probeSocket, startDaemon } from "@oh-my-pi/pi-utils";

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

/** Configuration options for startEmacsSession. */
export interface StartEmacsOptions {
	/** Socket filename prefix (default: "spell-emacs-"). */
	socketPrefix?: string;
	/** Maximum time to wait for the daemon socket (default: 120_000). */
	startupTimeoutMs?: number;
	/** Whether to attempt reattaching to an existing daemon (default: true). */
	tryReattach?: boolean;
	/** Emacs flags prepended before --fg-daemon (default: ["-Q"]). */
	emacsFlags?: string[];
	/**
	 * Custom elisp eval expressions to replace the default load sequence.
	 * When provided, these are used instead of the default pi-prelude/pi-emacs-mcp evals.
	 * Each entry becomes a `--eval "(expr)"` argument.
	 * The load-path setup and mcp-server-start-unix are always included.
	 */
	evalExpressions?: string[];
}

/**
 * Start (or return an existing) Emacs daemon for the given project + session.
 *
 * Sessions are cached by daemon flavor plus `hash(projectRoot + sessionId)`.
 * Two calls with the same project/session but different socket prefixes MUST start
 * distinct daemons so org callers cannot reuse the code-intelligence socket.
 *
 * @param emacsPath   - Absolute path to the emacs binary.
 * @param projectRoot - Absolute path to the project root (used for hashing).
 * @param sessionId   - Opaque session identifier (e.g. Pi session UUID).
 * @param elispDir    - Path to elisp/ directory to add to load-path.
 * @param options     - Optional daemon configuration overrides.
 */
export async function startEmacsSession(
	emacsPath: string,
	projectRoot: string,
	sessionId: string,
	elispDir: string,
	options?: StartEmacsOptions,
): Promise<EmacsSession> {
	const {
		socketPrefix = "spell-emacs-",
		startupTimeoutMs = STARTUP_TIMEOUT_MS,
		tryReattach: shouldReattach = true,
		emacsFlags = ["-Q"],
		evalExpressions,
	} = options ?? {};

	const prefix = socketPrefix;
	const daemonKey = sessionKey(projectRoot, sessionId);
	const cacheKey = cacheKeyForSession(daemonKey, prefix);

	const cached = sessions.get(cacheKey);
	if (cached?.isAlive()) {
		logger.debug("[emacs-daemon] Returning cached session", { cacheKey, socketPath: cached.socketPath });
		return cached;
	}

	// Stale entry — remove before relaunching.
	if (cached) sessions.delete(cacheKey);

	// Try to reattach to a daemon from a previous process.
	if (shouldReattach) {
		const attached = await tryAttachExisting(daemonKey, prefix, cacheKey);
		if (attached) {
			sessions.set(cacheKey, attached);
			logger.debug("[emacs-daemon] Reattached to existing daemon", { cacheKey, socketPath: attached.socketPath });
			return attached;
		}
	}

	const session = await launchDaemon(emacsPath, projectRoot, elispDir, daemonKey, cacheKey, {
		socketPrefix: prefix,
		startupTimeoutMs,
		emacsFlags,
		evalExpressions,
	});
	sessions.set(cacheKey, session);
	return session;
}

// ---------------------------------------------------------------------------
// Internal session cache
// ---------------------------------------------------------------------------

/** Module-level cache: daemon flavor + session hash → live EmacsSession. */
const sessions = new Map<string, EmacsSession>();

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

// First-run startup compiles all tree-sitter grammars (git clone + cc per language).
// At ~3-5s per grammar × 15 languages = ~75s worst case on a slow connection.
// Subsequent starts use cached .so files and take ~900ms.
const STARTUP_TIMEOUT_MS = 120_000;
const HEALTH_INTERVAL_MS = 5_000;
// Show a first-run warning after this many ms so users know spell is compiling
// tree-sitter grammars rather than hanging.
const FIRST_RUN_WARN_MS = 8_000;

/** Stable hash key derived from project root + session ID. */
function sessionKey(projectRoot: string, sessionId: string): string {
	const raw = Bun.hash(projectRoot + sessionId);
	return BigInt(raw).toString(16).slice(0, 12).padStart(12, "0");
}

function cacheKeyForSession(daemonKey: string, prefix: string): string {
	return `${prefix}${daemonKey}`;
}

/** Absolute path to the Unix socket for a given hash key. */
function socketPathForKey(hashHex: string, prefix: string): string {
	const dir = process.env.XDG_RUNTIME_DIR ?? "/tmp";
	return path.join(dir, `${prefix}${hashHex}.sock`);
}

/**
 * Probe for a daemon left behind by a previous process at the known socket path.
 * Returns a reattached EmacsSession if the daemon is still live, null otherwise.
 */
async function tryAttachExisting(daemonKey: string, prefix: string, cacheKey: string): Promise<EmacsSession | null> {
	const sock = socketPathForKey(daemonKey, prefix);
	const daemonName = `${prefix}${daemonKey}`;

	// If the socket file doesn't exist, there's nothing to attach to.
	try {
		await fs.access(sock);
	} catch (err) {
		if (isEnoent(err)) return null;
		return null;
	}

	// Probe the socket to see if the daemon is still listening.
	const alive = await probeSocket(sock, 1000);
	if (!alive) return null;

	// Daemon is live — build a lightweight session around it.
	// No ManagedDaemon here: we don't have a proc reference for reattached daemons.
	let isAlive = true;
	const healthTimer = setInterval(async () => {
		try {
			await fs.access(sock);
		} catch {
			logger.warn("[emacs-daemon] Socket disappeared — reattached daemon may have crashed", { daemonName, sock });
			isAlive = false;
			sessions.delete(cacheKey);
			clearInterval(healthTimer);
		}
	}, HEALTH_INTERVAL_MS);
	healthTimer.unref();

	return {
		socketPath: sock,

		isAlive(): boolean {
			return isAlive;
		},

		async stop(): Promise<void> {
			clearInterval(healthTimer);
			isAlive = false;
			sessions.delete(cacheKey);

			logger.debug("[emacs-daemon] Stopping reattached daemon", { daemonName });

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

interface LaunchOptions {
	socketPrefix: string;
	startupTimeoutMs: number;
	emacsFlags: string[];
	evalExpressions?: string[];
}

async function launchDaemon(
	emacsPath: string,
	projectRoot: string,
	elispDir: string,
	daemonKey: string,
	cacheKey: string,
	opts: LaunchOptions,
): Promise<EmacsSession> {
	const daemonName = `${opts.socketPrefix}${daemonKey}`;
	const sock = socketPathForKey(daemonKey, opts.socketPrefix);

	// Socket is stale (tryAttachExisting already confirmed it's dead) — remove before spawning.
	try {
		await fs.unlink(sock);
	} catch (err) {
		if (!isEnoent(err)) {
			logger.warn("[emacs-daemon] Could not remove stale socket", { sock, err: String(err) });
		}
	}

	// Build spawn command.
	// --fg-daemon keeps the process in the foreground so proc.pid tracks the live daemon.
	const evalArgs = buildEvalArgs(elispDir, projectRoot, sock, opts.evalExpressions);
	const command = [emacsPath, ...opts.emacsFlags, `--fg-daemon=${daemonName}`, ...evalArgs];

	// Show a first-run warning so users know we're compiling tree-sitter grammars.
	let firstRunTimer: NodeJS.Timeout | undefined;
	if (opts.startupTimeoutMs > FIRST_RUN_WARN_MS) {
		firstRunTimer = setTimeout(() => {
			process.stderr.write(
				`  Emacs (${daemonName}): installing tree-sitter grammars on first run, may take ~60s...\n`,
			);
		}, FIRST_RUN_WARN_MS);
	}

	logger.debug("[emacs-daemon] Spawning daemon", { daemonName, sock, elispDir });

	let daemon: ManagedDaemon;
	try {
		daemon = await startDaemon({
			name: daemonName,
			command,
			socketPath: sock,
			stopCommand: ["emacsclient", `--socket-name=${daemonName}`, "--eval", "(kill-emacs)"],
			healthIntervalMs: HEALTH_INTERVAL_MS,
			startupTimeoutMs: opts.startupTimeoutMs,
			logStderr: true,
			onCrash: () => {
				sessions.delete(cacheKey);
			},
		});
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		logger.error("[emacs-daemon] Daemon startup timed out", { daemonName, sock, err: msg });
		throw err;
	} finally {
		if (firstRunTimer) clearTimeout(firstRunTimer);
	}

	logger.debug("[emacs-daemon] Daemon ready", { daemonName, sock });

	return {
		socketPath: daemon.socketPath,

		isAlive(): boolean {
			return daemon.isAlive();
		},

		async stop(): Promise<void> {
			sessions.delete(cacheKey);
			await daemon.stop();
		},
	};
}

/**
 * Build the --eval argument list for the Emacs daemon.
 *
 * Default sequence: load-path → pi-project-root → pi-prelude → pi-emacs-mcp → mcp-server-start.
 * When evalExpressions is provided, those replace the pi-prelude/pi-emacs-mcp requires
 * while keeping load-path setup and mcp-server-start-unix.
 */
function buildEvalArgs(elispDir: string, projectRoot: string, sock: string, evalExpressions?: string[]): string[] {
	const args: string[] = [
		"--eval",
		`(add-to-list 'load-path "${elispDir}")`,
		"--eval",
		`(setq pi-project-root "${projectRoot}")`,
	];

	if (evalExpressions) {
		for (const expr of evalExpressions) {
			args.push("--eval", expr);
		}
	} else {
		// No default evals — callers must provide evalExpressions.
		// The code-intelligence daemon (pi-prelude, pi-emacs-mcp) has been removed;
		// the org daemon passes its own evalExpressions.
	}

	args.push("--eval", `(mcp-server-start-unix nil "${sock}")`);
	return args;
}
