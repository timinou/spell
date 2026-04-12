import { fileURLToPath } from "node:url";

const addonPath0 = fileURLToPath(new URL("../native/pi_natives.linux-x64-modern.node", import.meta.url));
const workerPath = fileURLToPath(new URL("../native/pi-embedding-worker", import.meta.url));

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

export const embeddedAddon: EmbeddedAddon | null = {
	platformTag: "linux-x64",
	version: "13.12.8",
	files: [{ variant: "modern", filename: "pi_natives.linux-x64-modern.node", filePath: addonPath0 }],
	worker: { filename: "pi-embedding-worker", filePath: workerPath },
};
