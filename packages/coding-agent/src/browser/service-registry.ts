import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { isEnoent, logger } from "@oh-my-pi/pi-utils";
import type { ServiceEntry, ServiceRegistryFile } from "./types";

const DEFAULT_REGISTRY_PATH = path.join(os.homedir(), ".spell", "browser", "services.json");
const WEBENGINE_STORAGE_ROOT = path.join(os.homedir(), ".local", "share", "omp-qml-bridge", "QtWebEngine");
const STORAGE_DIR_MODE = 0o700;
const MAX_STORAGE_NAME_LENGTH = 48;

/** Strip to [a-zA-Z0-9_-], collapse leading/trailing dashes, cap at 48 chars. Mirrors QML sanitizeKey. */
export function sanitizeStorageName(raw: string): string {
	return raw
		.trim()
		.replace(/[^a-zA-Z0-9_-]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, MAX_STORAGE_NAME_LENGTH);
}

export class ServiceRegistry {
	#registryPath: string;
	#storageRoot: string;

	constructor(registryPath?: string, storageRoot?: string) {
		this.#registryPath = registryPath ?? DEFAULT_REGISTRY_PATH;
		this.#storageRoot = storageRoot ?? WEBENGINE_STORAGE_ROOT;
	}

	get registryPath(): string {
		return this.#registryPath;
	}

	/** Resolve absolute path to a WebEngine storage directory for a given storageName. */
	resolveStoragePath(storageName: string): string {
		return path.join(this.#storageRoot, storageName);
	}

	async add(entry: Omit<ServiceEntry, "status">): Promise<void> {
		const sanitized = sanitizeStorageName(entry.profileStorage);
		if (sanitized.length === 0) {
			throw new Error(`Invalid profileStorage: sanitization of '${entry.profileStorage}' produced empty string`);
		}

		const data = await this.#read();

		// Check duplicate name
		if (data.services[entry.name]) {
			throw new ServiceRegistryError("service_exists", `Service '${entry.name}' already exists`);
		}

		// Check storageName collision (only for services that own their own storage, not children)
		if (!entry.parentService) {
			for (const existing of Object.values(data.services)) {
				if (existing.profileStorage === sanitized && !existing.parentService) {
					throw new ServiceRegistryError(
						"storage_collision",
						`Sanitized storageName '${sanitized}' collides with existing service '${existing.name}'`,
					);
				}
			}
		}

		const resolvedStorage = entry.parentService
			? this.#resolveParentStorage(data, entry.parentService, sanitized)
			: sanitized;

		const full: ServiceEntry = {
			...entry,
			profileStorage: resolvedStorage,
			status: "connected",
		};

		data.services[entry.name] = full;
		await this.#write(data);

		// Create storage directory if this service owns its own profile (not a child)
		if (!entry.parentService) {
			const storagePath = this.resolveStoragePath(resolvedStorage);
			await fs.mkdir(storagePath, { recursive: true, mode: STORAGE_DIR_MODE });
			// Ensure permissions even if dir already existed
			await fs.chmod(storagePath, STORAGE_DIR_MODE);
		}
	}

	async remove(name: string): Promise<void> {
		const data = await this.#read();
		const entry = data.services[name];
		if (!entry) {
			throw new ServiceRegistryError("service_not_found", `Service '${name}' not found`);
		}

		const storagePath = this.resolveStoragePath(entry.profileStorage);
		delete data.services[name];
		await this.#write(data);

		// Only delete storage if no other service references the same profileStorage
		const storageStillUsed = Object.values(data.services).some(s => s.profileStorage === entry.profileStorage);
		if (!storageStillUsed) {
			await fs.rm(storagePath, { recursive: true, force: true });
		}
	}

	async get(name: string): Promise<ServiceEntry | null> {
		const data = await this.#read();
		const entry = data.services[name];
		if (!entry) return null;

		// Check if storage directory actually exists
		const storagePath = this.resolveStoragePath(entry.profileStorage);
		try {
			await fs.access(storagePath);
		} catch {
			return { ...entry, status: "unknown" };
		}
		return entry;
	}

	async list(): Promise<ServiceEntry[]> {
		const data = await this.#read();
		return Object.values(data.services);
	}

	async resolveByDomain(domain: string): Promise<ServiceEntry | null> {
		const data = await this.#read();
		for (const entry of Object.values(data.services)) {
			if (entry.domains.includes(domain)) {
				return entry;
			}
		}
		return null;
	}

	async updateLastUsed(name: string): Promise<void> {
		const data = await this.#read();
		const entry = data.services[name];
		if (!entry) return;
		entry.lastUsed = new Date().toISOString();
		await this.#write(data);
	}

	async updateLastValidated(name: string): Promise<void> {
		const data = await this.#read();
		const entry = data.services[name];
		if (!entry) return;
		entry.lastValidated = new Date().toISOString();
		await this.#write(data);
	}

	/** Resolve parent's profileStorage, falling back to the provided sanitized name. */
	#resolveParentStorage(data: ServiceRegistryFile, parentName: string, fallback: string): string {
		const parent = data.services[parentName];
		return parent ? parent.profileStorage : fallback;
	}

	async #read(): Promise<ServiceRegistryFile> {
		try {
			const text = await Bun.file(this.#registryPath).text();
			const parsed = JSON.parse(text) as ServiceRegistryFile;
			if (!parsed || typeof parsed !== "object" || !parsed.services) {
				throw new Error("Invalid registry structure");
			}
			return parsed;
		} catch (err) {
			if (isEnoent(err)) {
				return { services: {} };
			}
			// Corrupt registry: backup and start fresh
			logger.warn("Service registry corrupt or invalid, backing up and starting fresh", {
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

	async #write(data: ServiceRegistryFile): Promise<void> {
		const dir = path.dirname(this.#registryPath);
		await fs.mkdir(dir, { recursive: true });

		const tmpPath = `${this.#registryPath}.tmp.${process.pid}`;
		await Bun.write(tmpPath, JSON.stringify(data, null, "\t"));
		await fs.rename(tmpPath, this.#registryPath);
	}
}

export class ServiceRegistryError extends Error {
	code: string;

	constructor(code: string, message: string) {
		super(message);
		this.name = "ServiceRegistryError";
		this.code = code;
	}
}
