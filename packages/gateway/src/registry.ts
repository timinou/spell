/**
 * Persistent service registry — JSON at ~/.spell/gateway/services.json.
 *
 * Atomic writes via rename-from-tmp. Corrupt file detection with backup.
 * Thread-safe serialized writes (no concurrent file mutations).
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { isEnoent, logger } from "@spell/pi-utils";
import { isValidAlias, PATHS, type ServiceConfig, type ServiceEntry, type ServiceStatus } from "./protocol";

export interface RegistryFile {
	services: Record<string, ServiceEntry>;
}

export class GatewayRegistryError extends Error {
	code: string;

	constructor(code: string, message: string) {
		super(message);
		this.name = "GatewayRegistryError";
		this.code = code;
	}
}

export class GatewayRegistry {
	#registryPath: string;
	#writeQueue: Promise<void> = Promise.resolve();

	constructor(registryPath?: string) {
		this.#registryPath = registryPath ?? PATHS.registry;
	}

	get registryPath(): string {
		return this.#registryPath;
	}

	async add(config: ServiceConfig): Promise<ServiceEntry> {
		if (!isValidAlias(config.alias)) {
			throw new GatewayRegistryError(
				"invalid_alias",
				`Invalid alias '${config.alias}': must be lowercase alphanumeric + hyphens, 1-63 chars, no leading/trailing hyphens`,
			);
		}

		return this.#serializedWrite(async data => {
			if (data.services[config.alias]) {
				throw new GatewayRegistryError("alias_conflict", `Alias '${config.alias}' is already registered`);
			}

			const entry: ServiceEntry = {
				...config,
				status: "active",
				createdAt: new Date().toISOString(),
			};
			data.services[config.alias] = entry;
			return entry;
		});
	}

	async remove(alias: string): Promise<void> {
		await this.#serializedWrite(async data => {
			if (!data.services[alias]) {
				throw new GatewayRegistryError("not_found", `Alias '${alias}' not found`);
			}
			delete data.services[alias];
		});
	}

	async get(alias: string): Promise<ServiceEntry | null> {
		const data = await this.#read();
		return data.services[alias] ?? null;
	}

	async list(): Promise<ServiceEntry[]> {
		const data = await this.#read();
		return Object.values(data.services);
	}

	async cleanupSession(sessionId: string): Promise<string[]> {
		const removed: string[] = [];
		await this.#serializedWrite(async data => {
			for (const [alias, entry] of Object.entries(data.services)) {
				if (entry.sessionId === sessionId && !entry.persistent) {
					delete data.services[alias];
					removed.push(alias);
				}
			}
		});
		return removed;
	}

	async updateStatus(alias: string, status: ServiceStatus, extra?: { pid?: number; error?: string }): Promise<void> {
		await this.#serializedWrite(async data => {
			const entry = data.services[alias];
			if (!entry) return;
			entry.status = status;
			entry.lastHealthCheck = new Date().toISOString();
			if (extra?.pid !== undefined) entry.pid = extra.pid;
			if (extra?.error !== undefined) entry.error = extra.error;
		});
	}

	// -----------------------------------------------------------------------
	// Internal
	// -----------------------------------------------------------------------

	async #read(): Promise<RegistryFile> {
		try {
			const text = await Bun.file(this.#registryPath).text();
			const parsed = JSON.parse(text) as RegistryFile;
			if (!parsed || typeof parsed !== "object" || !parsed.services) {
				throw new Error("Invalid registry structure");
			}
			return parsed;
		} catch (err) {
			if (isEnoent(err)) {
				return { services: {} };
			}
			logger.warn("[gateway] Registry corrupt or invalid, backing up and starting fresh", {
				path: this.#registryPath,
				error: err instanceof Error ? err.message : String(err),
			});
			try {
				await fs.rename(this.#registryPath, `${this.#registryPath}.bak`);
			} catch {
				// Best effort backup
			}
			return { services: {} };
		}
	}

	async #write(data: RegistryFile): Promise<void> {
		const dir = path.dirname(this.#registryPath);
		await fs.mkdir(dir, { recursive: true });

		const tmpPath = `${this.#registryPath}.tmp.${process.pid}`;
		await Bun.write(tmpPath, JSON.stringify(data, null, "\t"));
		await fs.rename(tmpPath, this.#registryPath);
	}

	/** Serialize write operations to prevent concurrent file mutations. */
	async #serializedWrite<T>(fn: (data: RegistryFile) => Promise<T>): Promise<T> {
		const { promise, resolve, reject } = Promise.withResolvers<T>();
		this.#writeQueue = this.#writeQueue.then(async () => {
			try {
				const data = await this.#read();
				const result = await fn(data);
				await this.#write(data);
				resolve(result);
			} catch (err) {
				reject(err);
			}
		});
		return promise;
	}
}
