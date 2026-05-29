import * as fs from "node:fs";
import * as path from "node:path";
/**
 * FNV-1a 64-bit hash of bytes. Mirrors the daemon's
 * `pi_knowledge_worker::repo_cache::fnv1a_64` so subscribe handles
 * round-trip correctly between client and daemon.
 *
 * Uses BigInt for the 64-bit arithmetic; bytes are processed one at a
 * time. Suitable for the small inputs used here (paths < 4 KB).
 */
function fnv1a64(bytes) {
    const offset = 0xcbf29ce484222325n;
    const prime = 0x100000001b3n;
    const mask = 0xffffffffffffffffn;
    let h = offset;
    for (const b of bytes) {
        h = (h ^ BigInt(b)) & mask;
        h = (h * prime) & mask;
    }
    return h;
}
/**
 * Compute the `fnv:hex16` repo handle the daemon uses to key its slot
 * map. Mirrors `pi_knowledge_worker::repo_cache::repo_hash`: canonicalize
 * the path (best-effort) and hash the lossy-utf8 byte representation.
 *
 * Falls back to the input path when canonicalize fails (e.g. doesn't
 * exist yet) — same behavior as the daemon.
 */
export function repoHandle(repoRoot) {
    let canonical;
    try {
        canonical = fs.realpathSync(repoRoot);
    }
    catch {
        canonical = path.resolve(repoRoot);
    }
    const bytes = Buffer.from(canonical, "utf8");
    const h = fnv1a64(bytes);
    return `fnv:${h.toString(16).padStart(16, "0")}`;
}
//# sourceMappingURL=handle.js.map