import * as path from "node:path";
import type { OrgConfig } from "@oh-my-pi/pi-org";
import { appendItemToFile, readCategory } from "@oh-my-pi/pi-org";

import { EventBus } from "../utils/event-bus";
import type { SwarmEventMap } from "../utils/typed-event-map";
import type { SwarmBlackboardEntry, SwarmBlackboardEntryInput, SwarmBlackboardRunContext } from "./types";

import { isDataUri } from "./uri";

type SwarmEventSink = Pick<EventBus<SwarmEventMap>, "emit">;

export interface SwarmBlackboardOptions {
	projectRoot: string;
	orgConfig: OrgConfig;
	eventBus?: SwarmEventSink;
}

export interface SwarmBlackboardFilter {
	agent?: string;
	type?: string;
}

export class SwarmBlackboard {
	readonly #projectRoot: string;
	readonly #orgConfig: OrgConfig;
	readonly #eventBus: SwarmEventSink;
	#run: SwarmBlackboardRunContext | null = null;
	#runId: string | null = null;
	#runFile: string | null = null;
	#categoryName: string | null = null;
	#dirName: string | null = null;
	#nextEntryIndex = 0;

	constructor(options: SwarmBlackboardOptions) {
		this.#projectRoot = options.projectRoot;
		this.#orgConfig = options.orgConfig;
		this.#eventBus = options.eventBus ?? new EventBus<SwarmEventMap>();
	}

	async open(run: SwarmBlackboardRunContext): Promise<SwarmBlackboardEntry> {
		this.#run = run;
		this.#runId = run.parentId ?? `SWARM-${run.sessionId}`;
		this.#categoryName = run.category ?? this.#defaultCategory();
		this.#dirName = this.#resolveDirName(this.#categoryName);
		const filePath = path.join(this.#categoryPath(this.#categoryName), `${this.#runId}.org`);
		this.#runFile = filePath;
		await appendItemToFile(
			filePath,
			{
				id: this.#runId,
				title: run.title,
				category: this.#categoryName,
				state: "ITEM",
				body: `Swarm run opened for ${run.agent}`,
				properties: { AGENT: run.agent, TYPE: "lifecycle" },
			},
			"ITEM",
			{ sessionId: run.sessionId },
		);
		return {
			id: this.#runId,
			runId: this.#runId,
			file: filePath,
			title: run.title,
			body: `Swarm run opened for ${run.agent}`,
			agent: run.agent,
			type: "lifecycle",
		};
	}

	async write(entry: SwarmBlackboardEntryInput): Promise<SwarmBlackboardEntry> {
		if (!this.#run || !this.#runId || !this.#runFile || !this.#categoryName) {
			throw new Error("blackboard not opened");
		}
		const entryId = `${this.#runId}-${String(++this.#nextEntryIndex).padStart(3, "0")}`;
		const body = entry.body.trimEnd();
		const properties = { AGENT: entry.agent, TYPE: entry.type, ...entry.properties };
		await appendItemToFile(
			this.#runFile,
			{ id: entryId, title: entry.title, category: this.#categoryName, state: "ITEM", body, properties },
			"ITEM",
		);
		if (entry.dataUri) {
			if (!isDataUri(entry.dataUri)) throw new Error(`invalid data URI: ${entry.dataUri}`);
			this.#eventBus.emit("swarm:artifact", {
				runId: this.#runId,
				entryId,
				agent: entry.agent,
				dataUri: entry.dataUri,
				type: entry.type,
			});
		}
		return { ...entry, id: entryId, runId: this.#runId, file: this.#runFile };
	}

	async close(note = "Swarm run closed"): Promise<void> {
		if (!this.#run || !this.#runId || !this.#runFile || !this.#categoryName) return;
		await appendItemToFile(
			this.#runFile,
			{
				id: `${this.#runId}-close`,
				title: note,
				category: this.#categoryName,
				state: "DONE",
				body: note,
				properties: { AGENT: this.#run.agent, TYPE: "lifecycle" },
			},
			"DONE",
		);
	}

	async read(filter: SwarmBlackboardFilter = {}): Promise<SwarmBlackboardEntry[]> {
		if (!this.#run || !this.#categoryName || !this.#dirName) return [];
		const items = await readCategory(
			this.#categoryPath(this.#categoryName),
			this.#categoryName,
			this.#dirName,
			["INIT", "ITEM", "DOING", "REVIEW", "DONE", "BLOCKED"],
			true,
		);
		return items
			.filter(item => item.id.startsWith(this.#runId ?? ""))
			.filter(item => !filter.agent || item.properties.AGENT === filter.agent)
			.filter(item => !filter.type || item.properties.TYPE === filter.type)
			.map(item => ({
				id: item.id,
				runId: this.#runId!,
				file: item.file,
				title: item.title,
				body: item.body ?? "",
				agent: item.properties.AGENT ?? "",
				type: (item.properties.TYPE as SwarmBlackboardEntryInput["type"]) ?? "progress",
			}));
	}

	#defaultCategory(): string {
		const firstDir = Object.values(this.#orgConfig.dirs)[0];
		if (!firstDir) throw new Error("no org directories configured");
		const firstCategory = Object.keys(firstDir.categories)[0];
		if (!firstCategory) throw new Error("no org categories configured");
		return firstCategory;
	}

	#resolveDirName(category: string): string {
		for (const [dirName, dir] of Object.entries(this.#orgConfig.dirs)) {
			if (dir.categories[category]) return dirName;
		}
		throw new Error(`unknown org category: ${category}`);
	}

	#categoryPath(category: string): string {
		for (const dir of Object.values(this.#orgConfig.dirs)) {
			const cat = dir.categories[category];
			if (cat) return path.resolve(this.#projectRoot, dir.path, cat.path);
		}
		throw new Error(`unknown org category: ${category}`);
	}
}
