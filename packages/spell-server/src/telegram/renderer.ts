import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { logger } from "@oh-my-pi/pi-utils";
import type { RendererConfig } from "../config/types";

export interface RenderRequest {
	rendererId: string;
	markdown: string;
	env?: Record<string, string>;
}

export type RenderResult =
	| { ok: true; bytes: Buffer; mime: string; extension: string; cached: boolean }
	| {
			ok: false;
			reason: "unknown_renderer" | "timeout" | "subprocess_error" | "circuit_open" | "io_error";
			message: string;
	  };

export interface RendererExecutorOpts {
	renderers: RendererConfig[];
	cwd: string;
	cacheCapacity?: number;
	breakerThreshold?: number;
	breakerCooldownMs?: number;
}

interface CacheEntry {
	bytes: Buffer;
	mime: string;
	extension: string;
}

interface BreakerState {
	failureCount: number;
	lastFailureTime: number;
}

/**
 * Simple LRU cache with fixed capacity.
 */
class LruCache<K, V> {
	private cache: Map<K, V> = new Map();

	constructor(private capacity: number) {}

	get(key: K): V | undefined {
		const val = this.cache.get(key);
		if (val !== undefined) {
			// Move to end (most recently used)
			this.cache.delete(key);
			this.cache.set(key, val);
		}
		return val;
	}

	set(key: K, val: V): void {
		if (this.cache.has(key)) {
			this.cache.delete(key);
		} else if (this.cache.size >= this.capacity) {
			// Evict least recently used (first entry)
			const keys = Array.from(this.cache.keys());
			if (keys.length > 0) {
				this.cache.delete(keys[0]);
			}
		}
		this.cache.set(key, val);
	}
}

export class RendererExecutor {
	private rendererMap: Map<string, RendererConfig>;
	private cache: LruCache<string, CacheEntry>;
	private breakerStates: Map<string, BreakerState> = new Map();
	private inFlightRequests: Map<string, Promise<RenderResult>> = new Map();
	private readonly cwd: string;
	private readonly breakerThreshold: number;
	private readonly breakerCooldownMs: number;

	constructor(opts: RendererExecutorOpts) {
		this.cwd = opts.cwd;
		this.breakerThreshold = opts.breakerThreshold ?? 3;
		this.breakerCooldownMs = opts.breakerCooldownMs ?? 60_000;
		this.cache = new LruCache(opts.cacheCapacity ?? 16);

		this.rendererMap = new Map();
		for (const renderer of opts.renderers) {
			this.rendererMap.set(renderer.id, renderer);
		}
	}

	async render(req: RenderRequest): Promise<RenderResult> {
		try {
			const renderer = this.rendererMap.get(req.rendererId);
			if (!renderer) {
				logger.warn("Unknown renderer requested", { rendererId: req.rendererId });
				return {
					ok: false,
					reason: "unknown_renderer",
					message: `No renderer found with ID: ${req.rendererId}`,
				};
			}

			// Check circuit breaker
			if (this.isCircuitOpen(req.rendererId)) {
				logger.warn("Circuit breaker open for renderer", {
					rendererId: req.rendererId,
					breakerThreshold: this.breakerThreshold,
				});
				return {
					ok: false,
					reason: "circuit_open",
					message: `Circuit breaker open for renderer ${req.rendererId}`,
				};
			}

			// Check cache if cacheBy is enabled
			if (renderer.cacheBy === "transcript-hash") {
				const cacheKey = this.computeCacheKey(req.markdown, renderer, req.env);
				const cached = this.cache.get(cacheKey);
				if (cached) {
					logger.debug("Cache hit for renderer", { rendererId: req.rendererId });
					return {
						ok: true,
						bytes: cached.bytes,
						mime: cached.mime,
						extension: cached.extension,
						cached: true,
					};
				}

				// Check in-flight requests to deduplicate concurrent renders
				const inFlightKey = cacheKey;
				if (this.inFlightRequests.has(inFlightKey)) {
					logger.debug("Waiting for in-flight request", { rendererId: req.rendererId });
					const result = await this.inFlightRequests.get(inFlightKey)!;
					// Return result but mark as not from cache (it's from in-flight dedup)
					if (result.ok) {
						return { ...result, cached: false };
					}
					return result;
				}

				// Spawn new subprocess and track in-flight
				const renderPromise = this.spawnRenderer(renderer, req.markdown, req.env);
				this.inFlightRequests.set(inFlightKey, renderPromise);

				const result = await renderPromise;
				this.inFlightRequests.delete(inFlightKey);

				if (result.ok) {
					// Store in cache
					this.cache.set(inFlightKey, {
						bytes: result.bytes,
						mime: renderer.mime,
						extension: renderer.extension,
					});
					// Reset breaker on success
					this.breakerStates.delete(req.rendererId);
				} else {
					// Increment breaker counter on failure
					this.incrementBreakerFailure(req.rendererId);
				}

				return result;
			} else {
				// No caching, just spawn
				const result = await this.spawnRenderer(renderer, req.markdown, req.env);

				if (result.ok) {
					// Reset breaker on success
					this.breakerStates.delete(req.rendererId);
				} else {
					// Increment breaker counter on failure
					this.incrementBreakerFailure(req.rendererId);
				}

				return result;
			}
		} catch (err) {
			// Should not happen, but log as safeguard
			logger.error("Unexpected error in RendererExecutor.render", {
				rendererId: req.rendererId,
				error: err instanceof Error ? err.message : String(err),
			});
			return {
				ok: false,
				reason: "io_error",
				message: `Unexpected error: ${err instanceof Error ? err.message : String(err)}`,
			};
		}
	}

	resetBreaker(rendererId: string): void {
		this.breakerStates.delete(rendererId);
	}

	private isCircuitOpen(rendererId: string): boolean {
		const state = this.breakerStates.get(rendererId);
		if (!state) {
			return false;
		}
		// If we've had threshold failures and cooldown hasn't elapsed, circuit is open
		if (state.failureCount >= this.breakerThreshold) {
			const elapsed = Date.now() - state.lastFailureTime;
			return elapsed < this.breakerCooldownMs;
		}
		return false;
	}

	private incrementBreakerFailure(rendererId: string): void {
		const state = this.breakerStates.get(rendererId) ?? { failureCount: 0, lastFailureTime: Date.now() };
		state.failureCount += 1;
		state.lastFailureTime = Date.now();
		this.breakerStates.set(rendererId, state);
	}

	private computeCacheKey(markdown: string, renderer: RendererConfig, env?: Record<string, string>): string {
		const rendererSignature = this.computeRendererSignature(renderer);
		const canonicalEnv = env ? JSON.stringify(Object.entries(env).sort(([a], [b]) => a.localeCompare(b))) : "{}";
		const combined = markdown + rendererSignature + canonicalEnv;
		return createHash("sha256").update(combined).digest("hex");
	}

	private computeRendererSignature(renderer: RendererConfig): string {
		const parts = [renderer.command, ...renderer.args, renderer.mime, renderer.extension];
		return parts.join("\0");
	}

	private spawnRenderer(
		renderer: RendererConfig,
		markdown: string,
		extraEnv?: Record<string, string>,
	): Promise<RenderResult> {
		return new Promise(resolve => {
			const child = spawn(renderer.command, renderer.args, {
				cwd: this.cwd,
				stdio: ["pipe", "pipe", "pipe"],
				env: { ...process.env, ...(renderer.env ?? {}), ...(extraEnv ?? {}) },
			});

			const outBuffers: Buffer[] = [];
			const errBuffers: Buffer[] = [];
			let settled = false;
			let timeoutHandle: NodeJS.Timeout | undefined;

			const finish = (fn: () => void) => {
				if (settled) return;
				settled = true;
				if (timeoutHandle) {
					clearTimeout(timeoutHandle);
				}
				fn();
			};

			// Timeout handler
			timeoutHandle = setTimeout(() => {
				child.kill("SIGKILL");
				finish(() => {
					logger.warn("Renderer subprocess timeout", {
						rendererId: renderer.id,
						timeoutMs: renderer.timeoutMs,
					});
					resolve({
						ok: false,
						reason: "timeout",
						message: `Renderer subprocess exceeded timeout of ${renderer.timeoutMs}ms`,
					});
				});
			}, renderer.timeoutMs);

			child.stdout?.on("data", (data: Buffer) => {
				outBuffers.push(data);
			});

			child.stderr?.on("data", (data: Buffer) => {
				errBuffers.push(data);
			});

			child.on("error", (err: Error) => {
				finish(() => {
					logger.error("Renderer subprocess spawn error", {
						rendererId: renderer.id,
						error: err.message,
					});
					resolve({
						ok: false,
						reason: "io_error",
						message: `Subprocess error: ${err.message}`,
					});
				});
			});

			child.on("close", (code: number | null) => {
				finish(() => {
					if (code === 0) {
						logger.debug("Renderer subprocess completed successfully", {
							rendererId: renderer.id,
							outputSize: outBuffers.reduce((sum, b) => sum + b.length, 0),
						});
						const bytes = Buffer.concat(outBuffers);
						resolve({
							ok: true,
							bytes,
							mime: renderer.mime,
							extension: renderer.extension,
							cached: false,
						});
					} else {
						const stderrText = Buffer.concat(errBuffers).toString("utf-8");
						logger.warn("Renderer subprocess exited with non-zero code", {
							rendererId: renderer.id,
							exitCode: code,
							stderrLength: stderrText.length,
						});
						resolve({
							ok: false,
							reason: "subprocess_error",
							message: stderrText || `Subprocess exited with code ${code}`,
						});
					}
				});
			});

			// Write markdown to stdin and close
			if (child.stdin) {
				child.stdin.write(markdown);
				child.stdin.end();
			}
		});
	}
}
