/**
 * Centralized path helpers for spell config directories.
 *
 * Uses PI_CONFIG_DIR (default ".spell") for the config root and
 * PI_CODING_AGENT_DIR to override the agent directory.
 *
 * On Linux, if XDG_DATA_HOME / XDG_STATE_HOME / XDG_CACHE_HOME environment
 * variables are set, paths are redirected to XDG-compliant locations under
 * $XDG_*_HOME/omp/. This requires running `omp config migrate` first to
 * move data to the new locations. No filesystem existence checks are performed
 * — if the env var is set, omp trusts that the migration has been done.
 */
/** App name (e.g. "spell") */
export declare const APP_NAME: string;
/** Config directory name (e.g. ".spell") */
export declare const CONFIG_DIR_NAME: string;
/** Version (e.g. "1.0.0") */
export declare const VERSION: string;
/** Minimum Bun version */
export declare const MIN_BUN_VERSION: string;
export declare function resolveEquivalentPath(inputPath: string): string;
export declare function normalizePathForComparison(inputPath: string): string;
export declare function pathIsWithin(root: string, candidate: string): boolean;
export declare function relativePathWithinRoot(root: string, candidate: string): string | null;
/** Get the project directory. */
export declare function getProjectDir(): string;
/** Set the project directory. */
export declare function setProjectDir(dir: string): void;
/** Get the config directory name relative to home (e.g. ".spell" or PI_CONFIG_DIR override). */
export declare function getConfigDirName(): string;
/** Get the config agent directory name relative to home (e.g. ".omp/agent" or PI_CONFIG_DIR + "/agent"). */
export declare function getConfigAgentDirName(): string;
/** Get the config root directory (~/.omp). */
export declare function getConfigRootDir(): string;
/** Set the coding agent directory. Creates a fresh resolver, invalidating all cached paths. */
export declare function setAgentDir(dir: string): void;
/** Get the agent config directory (~/.spell/agent). */
export declare function getAgentDir(): string;
/** Get the project-local config directory (.spell). */
export declare function getProjectAgentDir(cwd?: string): string;
/**
 * Path to the user-tier spell.kdl.
 *
 * - PI_USER_KDL env var overrides everything (absolute path expected).
 * - Otherwise: $XDG_CONFIG_HOME/spell/spell.kdl, falling back to
 *   ~/.config/spell/spell.kdl.
 *
 * Decoupled from getAgentDir() on purpose: ~/.spell/ remains the home for
 * runtime state (sessions/plugins/logs/etc.); user *config* moves to the
 * XDG-compliant location.
 */
export declare function getUserKdlPath(): string;
/** Path to the committed project-tier spell.kdl. */
export declare function getProjectKdlPath(cwd?: string): string;
/**
 * Path to the gitignored machine-local-tier spell.kdl.
 *
 * <cwd>/.local/spell.kdl — intended to be excluded from VCS and to hold
 * per-machine overrides (paths, credentials, personal preferences).
 */
export declare function getLocalKdlPath(cwd?: string): string;
/**
 * Legacy user-tier KDL location (~/.spell/spell.kdl), pre-XDG cutover.
 * The one-shot migrator reads this and writes forward to getUserKdlPath().
 * Safe to delete once the migration directory is removed.
 */
export declare function getLegacyUserKdlPath(): string;
/** Get the reports directory (~/.spell/reports). */
export declare function getReportsDir(): string;
/** Get the logs directory (~/.spell/logs). */
export declare function getLogsDir(): string;
/** Get the path to a dated log file (~/.spell/logs/spell.YYYY-MM-DD.log). */
export declare function getLogPath(date?: Date): string;
/** Get the plugins directory (~/.spell/plugins). */
export declare function getPluginsDir(): string;
/** Where npm installs packages (~/.spell/plugins/node_modules). */
export declare function getPluginsNodeModules(): string;
/** Plugin manifest (~/.spell/plugins/package.json). */
export declare function getPluginsPackageJson(): string;
/** Plugin lock file (~/.spell/plugins/spell-plugins.lock.json). */
export declare function getPluginsLockfile(): string;
/** Get the remote mount directory (~/.spell/remote). */
export declare function getRemoteDir(): string;
/** Get the SSH control socket directory (~/.spell/ssh-control). */
export declare function getSshControlDir(): string;
/** Get the remote host info directory (~/.spell/remote-host). */
export declare function getRemoteHostDir(): string;
/** Get the managed Python venv directory (~/.spell/python-env). */
export declare function getPythonEnvDir(): string;
/** Get the puppeteer sandbox directory (~/.spell/puppeteer). */
export declare function getPuppeteerDir(): string;
/** Get the worktree base directory (~/.spell/wt). */
export declare function getWorktreeBaseDir(): string;
/** Get the path to a worktree directory (~/.spell/wt/<project>/<id>). */
export declare function getWorktreeDir(encodedProject: string, id: string): string;
/** Get the GPU cache path (~/.spell/gpu_cache.json). */
export declare function getGpuCachePath(): string;
/** Get the natives directory (~/.spell/natives). */
export declare function getNativesDir(): string;
/** Get the stats database path (~/.spell/stats.db). */
export declare function getStatsDbPath(): string;
/** Get the path to agent.db (SQLite database for settings and auth storage). */
export declare function getAgentDbPath(agentDir?: string): string;
/** Get the path to history.db (SQLite database for session history). */
export declare function getHistoryDbPath(agentDir?: string): string;
/** Get the path to models.db (model cache database). */
export declare function getModelDbPath(agentDir?: string): string;
/** Get the sessions directory (~/.spell/agent/sessions). */
export declare function getSessionsDir(agentDir?: string): string;
/** Get the content-addressed blob store directory (~/.spell/agent/blobs). */
export declare function getBlobsDir(agentDir?: string): string;
/** Get the custom themes directory (~/.spell/agent/themes). */
export declare function getCustomThemesDir(agentDir?: string): string;
/** Get the tools directory (~/.spell/agent/tools). */
export declare function getToolsDir(agentDir?: string): string;
/** Get the slash commands directory (~/.spell/agent/commands). */
export declare function getCommandsDir(agentDir?: string): string;
/** Get the prompts directory (~/.spell/agent/prompts). */
export declare function getPromptsDir(agentDir?: string): string;
/** Get the user-level Python modules directory (~/.spell/agent/modules). */
export declare function getAgentModulesDir(agentDir?: string): string;
/** Get the memories directory (~/.spell/agent/memories). */
export declare function getMemoriesDir(agentDir?: string): string;
/** Get the terminal sessions directory (~/.spell/agent/terminal-sessions). */
export declare function getTerminalSessionsDir(agentDir?: string): string;
/** Get the crash log path (~/.spell/agent/spell-crash.log). */
export declare function getCrashLogPath(agentDir?: string): string;
/** Get the debug log path (~/.spell/agent/spell-debug.log). */
export declare function getDebugLogPath(agentDir?: string): string;
/** Get the project-level Python modules directory (.spell/modules). */
export declare function getProjectModulesDir(cwd?: string): string;
/** Get the project-level prompts directory (.spell/prompts). */
export declare function getProjectPromptsDir(cwd?: string): string;
/** Get the project-level plugin overrides path (.spell/plugin-overrides.json). */
export declare function getProjectPluginOverridesPath(cwd?: string): string;
/** Get the primary MCP config file path (first candidate). */
export declare function getMCPConfigPath(scope: "user" | "project", cwd?: string): string;
/** Get the SSH config file path. */
export declare function getSSHConfigPath(scope: "user" | "project", cwd?: string): string;
//# sourceMappingURL=dirs.d.ts.map