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
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { engines, version } from "../package.json" with { type: "json" };
/** App name (e.g. "spell") */
export const APP_NAME = "spell";
/** Config directory name (e.g. ".spell") */
export const CONFIG_DIR_NAME = ".spell";
/** Version (e.g. "1.0.0") */
export const VERSION = version;
/** Minimum Bun version */
export const MIN_BUN_VERSION = engines.bun.replace(/[^0-9.]/g, "");
// =============================================================================
// Project directory
// =============================================================================
/**
 * On macOS, strip /private prefix only when both paths resolve to the same location.
 * This preserves aliases like /private/tmp -> /tmp without rewriting unrelated paths.
 */
function standardizeMacOSPath(p) {
    if (process.platform !== "darwin" || !p.startsWith("/private/"))
        return p;
    const stripped = p.slice("/private".length);
    try {
        if (fs.realpathSync(p) === fs.realpathSync(stripped)) {
            return stripped;
        }
    }
    catch { }
    return p;
}
export function resolveEquivalentPath(inputPath) {
    const resolvedPath = path.resolve(inputPath);
    try {
        return fs.realpathSync(resolvedPath);
    }
    catch {
        return resolvedPath;
    }
}
export function normalizePathForComparison(inputPath) {
    const resolvedPath = resolveEquivalentPath(inputPath);
    return process.platform === "win32" ? resolvedPath.toLowerCase() : resolvedPath;
}
export function pathIsWithin(root, candidate) {
    const normalizedRoot = normalizePathForComparison(root);
    const normalizedCandidate = normalizePathForComparison(candidate);
    const relative = path.relative(normalizedRoot, normalizedCandidate);
    return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}
export function relativePathWithinRoot(root, candidate) {
    if (!pathIsWithin(root, candidate))
        return null;
    const normalizedRoot = normalizePathForComparison(root);
    const normalizedCandidate = normalizePathForComparison(candidate);
    const relative = path.relative(normalizedRoot, normalizedCandidate);
    return relative || null;
}
let projectDir = standardizeMacOSPath(process.cwd());
/** Get the project directory. */
export function getProjectDir() {
    return projectDir;
}
/** Set the project directory. */
export function setProjectDir(dir) {
    projectDir = standardizeMacOSPath(path.resolve(dir));
    process.chdir(projectDir);
}
/** Get the config directory name relative to home (e.g. ".spell" or PI_CONFIG_DIR override). */
export function getConfigDirName() {
    return process.env.PI_CONFIG_DIR || CONFIG_DIR_NAME;
}
/** Get the config agent directory name relative to home (e.g. ".omp/agent" or PI_CONFIG_DIR + "/agent"). */
export function getConfigAgentDirName() {
    return `${getConfigDirName()}/agent`;
}
/**
 * Resolves and caches all omp directory paths. On Linux, when XDG environment
 * variables are set, paths are redirected under $XDG_*_HOME/omp/. A new
 * instance is created whenever the agent directory changes, which naturally
 * invalidates all cached paths.
 */
class DirResolver {
    // Per-category base dirs. Without XDG, all three equal configRoot / agentDir.
    // With XDG on Linux, they point to $XDG_*_HOME/omp/.
    #rootDirs;
    #agentDirs;
    #rootCache = new Map();
    #agentCache = new Map();
    constructor(agentDirOverride) {
        this.configRoot = path.join(os.homedir(), getConfigDirName());
        const defaultAgent = path.join(this.configRoot, "agent");
        this.agentDir = agentDirOverride ? path.resolve(agentDirOverride) : defaultAgent;
        const isDefault = this.agentDir === defaultAgent;
        // XDG is a Linux convention. On other platforms, or for non-default
        // profiles, all categories resolve to the legacy paths.
        let xdgData;
        let xdgState;
        let xdgCache;
        if ((process.platform === "linux" || process.platform === "darwin") && isDefault) {
            const resolveIf = (envVar) => {
                const value = process.env[envVar];
                if (value) {
                    try {
                        const joined = path.join(value, APP_NAME);
                        if (fs.existsSync(joined)) {
                            return joined;
                        }
                    }
                    catch { }
                }
                return undefined;
            };
            xdgData = resolveIf("XDG_DATA_HOME");
            xdgState = resolveIf("XDG_STATE_HOME");
            xdgCache = resolveIf("XDG_CACHE_HOME");
        }
        this.#rootDirs = {
            data: xdgData ?? this.configRoot,
            state: xdgState ?? this.configRoot,
            cache: xdgCache ?? this.configRoot,
        };
        // XDG flattens the agent/ prefix: ~/.omp/agent/sessions → $XDG_DATA_HOME/omp/sessions
        this.#agentDirs = {
            data: xdgData ?? this.agentDir,
            state: xdgState ?? this.agentDir,
            cache: xdgCache ?? this.agentDir,
        };
    }
    /** Config-root subdirectory, with optional XDG override. */
    rootSubdir(subdir, xdg) {
        const cached = this.#rootCache.get(subdir);
        if (cached)
            return cached;
        const base = xdg ? this.#rootDirs[xdg] : this.configRoot;
        const result = path.join(base, subdir);
        this.#rootCache.set(subdir, result);
        return result;
    }
    /** Agent subdirectory, with optional XDG override. */
    agentSubdir(userAgentDir, subdir, xdg) {
        if (!userAgentDir || userAgentDir === this.agentDir) {
            const cached = this.#agentCache.get(subdir);
            if (cached)
                return cached;
            const base = xdg ? this.#agentDirs[xdg] : this.agentDir;
            const result = path.join(base, subdir);
            this.#agentCache.set(subdir, result);
            return result;
        }
        return path.join(userAgentDir, subdir);
    }
}
let dirs = new DirResolver(process.env.PI_CODING_AGENT_DIR);
// =============================================================================
// Root directories
// =============================================================================
/** Get the config root directory (~/.omp). */
export function getConfigRootDir() {
    return dirs.configRoot;
}
/** Set the coding agent directory. Creates a fresh resolver, invalidating all cached paths. */
export function setAgentDir(dir) {
    dirs = new DirResolver(dir);
    process.env.PI_CODING_AGENT_DIR = dir;
}
/** Get the agent config directory (~/.spell/agent). */
export function getAgentDir() {
    return dirs.agentDir;
}
/** Get the project-local config directory (.spell). */
export function getProjectAgentDir(cwd = getProjectDir()) {
    return path.join(cwd, CONFIG_DIR_NAME);
}
// =============================================================================
// KDL config file paths
// =============================================================================
//
// Four-tier settings model. State (sessions/plugins/logs) stays under the
// legacy agent dir; only the KDL config files live in the new locations.
//
//   session  in-memory                          volatile
//   local    <cwd>/.local/spell.kdl             gitignored, machine
//   project  <cwd>/spell.kdl                    committed, team
//   user     ~/.config/spell/spell.kdl          XDG-style global
//
// Read precedence: session > local > project > user (last-write-per-key wins).
//
// XDG: honors XDG_CONFIG_HOME on Linux/macOS for the user tier. PI_USER_KDL
// overrides the user path entirely (test / advanced use).
/** Resolve the XDG config home, defaulting to ~/.config. */
function getXdgConfigHome() {
    const envHome = process.env.XDG_CONFIG_HOME;
    if (envHome && envHome.length > 0)
        return envHome;
    return path.join(os.homedir(), ".config");
}
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
export function getUserKdlPath() {
    const override = process.env.PI_USER_KDL;
    if (override && override.length > 0)
        return path.resolve(override);
    return path.join(getXdgConfigHome(), APP_NAME, "spell.kdl");
}
/** Path to the committed project-tier spell.kdl. */
export function getProjectKdlPath(cwd = getProjectDir()) {
    return path.join(cwd, "spell.kdl");
}
/**
 * Path to the gitignored machine-local-tier spell.kdl.
 *
 * <cwd>/.local/spell.kdl — intended to be excluded from VCS and to hold
 * per-machine overrides (paths, credentials, personal preferences).
 */
export function getLocalKdlPath(cwd = getProjectDir()) {
    return path.join(cwd, ".local", "spell.kdl");
}
/**
 * Legacy user-tier KDL location (~/.spell/spell.kdl), pre-XDG cutover.
 * The one-shot migrator reads this and writes forward to getUserKdlPath().
 * Safe to delete once the migration directory is removed.
 */
export function getLegacyUserKdlPath() {
    return path.join(path.dirname(getAgentDir()), "spell.kdl");
}
// =============================================================================
// Config-root subdirectories (~/.spell/*)
// =============================================================================
/** Get the reports directory (~/.spell/reports). */
export function getReportsDir() {
    return dirs.rootSubdir("reports", "state");
}
/** Get the logs directory (~/.spell/logs). */
export function getLogsDir() {
    return dirs.rootSubdir("logs", "state");
}
/** Get the path to a dated log file (~/.spell/logs/spell.YYYY-MM-DD.log). */
export function getLogPath(date = new Date()) {
    return path.join(getLogsDir(), `${APP_NAME}.${date.toISOString().slice(0, 10)}.log`);
}
/** Get the plugins directory (~/.spell/plugins). */
export function getPluginsDir() {
    return dirs.rootSubdir("plugins", "data");
}
/** Where npm installs packages (~/.spell/plugins/node_modules). */
export function getPluginsNodeModules() {
    return path.join(getPluginsDir(), "node_modules");
}
/** Plugin manifest (~/.spell/plugins/package.json). */
export function getPluginsPackageJson() {
    return path.join(getPluginsDir(), "package.json");
}
/** Plugin lock file (~/.spell/plugins/spell-plugins.lock.json). */
export function getPluginsLockfile() {
    return path.join(getPluginsDir(), "spell-plugins.lock.json");
}
/** Get the remote mount directory (~/.spell/remote). */
export function getRemoteDir() {
    return dirs.rootSubdir("remote", "data");
}
/** Get the SSH control socket directory (~/.spell/ssh-control). */
export function getSshControlDir() {
    return dirs.rootSubdir("ssh-control", "state");
}
/** Get the remote host info directory (~/.spell/remote-host). */
export function getRemoteHostDir() {
    return dirs.rootSubdir("remote-host", "data");
}
/** Get the managed Python venv directory (~/.spell/python-env). */
export function getPythonEnvDir() {
    return dirs.rootSubdir("python-env", "data");
}
/** Get the puppeteer sandbox directory (~/.spell/puppeteer). */
export function getPuppeteerDir() {
    return dirs.rootSubdir("puppeteer", "cache");
}
/** Get the worktree base directory (~/.spell/wt). */
export function getWorktreeBaseDir() {
    return dirs.rootSubdir("wt", "data");
}
/** Get the path to a worktree directory (~/.spell/wt/<project>/<id>). */
export function getWorktreeDir(encodedProject, id) {
    return path.join(getWorktreeBaseDir(), encodedProject, id);
}
/** Get the GPU cache path (~/.spell/gpu_cache.json). */
export function getGpuCachePath() {
    return dirs.rootSubdir("gpu_cache.json", "cache");
}
/** Get the natives directory (~/.spell/natives). */
export function getNativesDir() {
    return dirs.rootSubdir("natives", "cache");
}
/** Get the stats database path (~/.spell/stats.db). */
export function getStatsDbPath() {
    return dirs.rootSubdir("stats.db", "data");
}
// =============================================================================
// Agent subdirectories (~/.spell/agent/*)
// =============================================================================
/** Get the path to agent.db (SQLite database for settings and auth storage). */
export function getAgentDbPath(agentDir) {
    return dirs.agentSubdir(agentDir, "agent.db", "data");
}
/** Get the path to history.db (SQLite database for session history). */
export function getHistoryDbPath(agentDir) {
    return dirs.agentSubdir(agentDir, "history.db", "data");
}
/** Get the path to models.db (model cache database). */
export function getModelDbPath(agentDir) {
    return dirs.agentSubdir(agentDir, "models.db", "data");
}
/** Get the sessions directory (~/.spell/agent/sessions). */
export function getSessionsDir(agentDir) {
    return dirs.agentSubdir(agentDir, "sessions", "data");
}
/** Get the content-addressed blob store directory (~/.spell/agent/blobs). */
export function getBlobsDir(agentDir) {
    return dirs.agentSubdir(agentDir, "blobs", "data");
}
/** Get the custom themes directory (~/.spell/agent/themes). */
export function getCustomThemesDir(agentDir) {
    return dirs.agentSubdir(agentDir, "themes");
}
/** Get the tools directory (~/.spell/agent/tools). */
export function getToolsDir(agentDir) {
    return dirs.agentSubdir(agentDir, "tools");
}
/** Get the slash commands directory (~/.spell/agent/commands). */
export function getCommandsDir(agentDir) {
    return dirs.agentSubdir(agentDir, "commands");
}
/** Get the prompts directory (~/.spell/agent/prompts). */
export function getPromptsDir(agentDir) {
    return dirs.agentSubdir(agentDir, "prompts");
}
/** Get the user-level Python modules directory (~/.spell/agent/modules). */
export function getAgentModulesDir(agentDir) {
    return dirs.agentSubdir(agentDir, "modules");
}
/** Get the memories directory (~/.spell/agent/memories). */
export function getMemoriesDir(agentDir) {
    return dirs.agentSubdir(agentDir, "memories", "state");
}
/** Get the terminal sessions directory (~/.spell/agent/terminal-sessions). */
export function getTerminalSessionsDir(agentDir) {
    return dirs.agentSubdir(agentDir, "terminal-sessions", "state");
}
/** Get the crash log path (~/.spell/agent/spell-crash.log). */
export function getCrashLogPath(agentDir) {
    return dirs.agentSubdir(agentDir, "spell-crash.log", "state");
}
/** Get the debug log path (~/.spell/agent/spell-debug.log). */
export function getDebugLogPath(agentDir) {
    return dirs.agentSubdir(agentDir, `${APP_NAME}-debug.log`, "state");
}
// =============================================================================
// Project subdirectories (.spell/*)
// =============================================================================
/** Get the project-level Python modules directory (.spell/modules). */
export function getProjectModulesDir(cwd = getProjectDir()) {
    return path.join(getProjectAgentDir(cwd), "modules");
}
/** Get the project-level prompts directory (.spell/prompts). */
export function getProjectPromptsDir(cwd = getProjectDir()) {
    return path.join(getProjectAgentDir(cwd), "prompts");
}
/** Get the project-level plugin overrides path (.spell/plugin-overrides.json). */
export function getProjectPluginOverridesPath(cwd = getProjectDir()) {
    return path.join(getProjectAgentDir(cwd), "plugin-overrides.json");
}
// =============================================================================
// MCP config paths
// =============================================================================
/** Get the primary MCP config file path (first candidate). */
export function getMCPConfigPath(scope, cwd = getProjectDir()) {
    if (scope === "user") {
        return path.join(getAgentDir(), "mcp.json");
    }
    return path.join(getProjectAgentDir(cwd), "mcp.json");
}
/** Get the SSH config file path. */
export function getSSHConfigPath(scope, cwd = getProjectDir()) {
    if (scope === "user") {
        return path.join(getAgentDir(), "ssh.json");
    }
    return path.join(getProjectAgentDir(cwd), "ssh.json");
}
//# sourceMappingURL=dirs.js.map