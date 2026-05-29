/**
 * Compute the `fnv:hex16` repo handle the daemon uses to key its slot
 * map. Mirrors `pi_knowledge_worker::repo_cache::repo_hash`: canonicalize
 * the path (best-effort) and hash the lossy-utf8 byte representation.
 *
 * Falls back to the input path when canonicalize fails (e.g. doesn't
 * exist yet) — same behavior as the daemon.
 */
export declare function repoHandle(repoRoot: string): string;
//# sourceMappingURL=handle.d.ts.map