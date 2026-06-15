export type EmbeddedAddonVariant = "modern" | "baseline" | "default";

export interface EmbeddedAddonFile {
	variant: EmbeddedAddonVariant;
	filename: string;
	filePath: string;
}

export interface EmbeddedAddonWorker {
	filename: string;
	filePath: string;
}

export interface EmbeddedAddon {
	platformTag: string;
	version: string;
	files: EmbeddedAddonFile[];
	worker: EmbeddedAddonWorker | null;
}

export const embeddedAddon: EmbeddedAddon | null = null;
