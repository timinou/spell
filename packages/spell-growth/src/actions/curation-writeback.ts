import * as fs from "node:fs/promises";
import * as path from "node:path";
import { isEnoent } from "@oh-my-pi/pi-utils";
import type { GrowthCurationWritebackInput } from "./types";
import { loadSourceRegistry } from "../registries/source-loader";

export interface GrowthCurationWritebackResult {
	registryPath: string;
	normalizedArtifactPath: string;
	patchArtifactPath: string;
}

function renderSourceRecord(input: GrowthCurationWritebackInput["record"]): string {
	return `source \"${input.slug}\" label=\"${input.label}\" kind=\"${input.kind}\" value=\"${input.value}\" direct=#${input.direct ? "true" : "false"} priority=${input.priority}`;
}

export async function writeGrowthCuration(input: GrowthCurationWritebackInput): Promise<GrowthCurationWritebackResult> {
	let currentText = "";
	try {
		currentText = await Bun.file(input.registryPath).text();
	} catch (error) {
		if (!isEnoent(error)) {
			throw error;
		}
	}
	const currentRecords = currentText.trim() ? loadSourceRegistry(currentText) : [];
	const existing = currentRecords.find(record => record.slug === input.record.slug);
	if (input.operation === "append" && existing) {
		throw new Error(`Source ${input.record.slug} already exists`);
	}
	if (input.operation === "update" && !existing) {
		throw new Error(`Source ${input.record.slug} does not exist`);
	}
	const rendered = renderSourceRecord(input.record);
	const nextText =
		input.operation === "append"
			? `${currentText.trim()}${currentText.trim() ? "\n" : ""}${rendered}\n`
			: `${currentText.replace(new RegExp(`^source \\\"${input.record.slug}\\\".*$`, "m"), rendered)}${currentText.endsWith("\n") ? "" : "\n"}`;
	await Bun.write(input.registryPath, nextText);
	await fs.mkdir(input.artifactDir, { recursive: true });
	const normalizedArtifactPath = path.join(input.artifactDir, `${input.record.slug}.json`);
	const patchArtifactPath = path.join(input.artifactDir, `${input.record.slug}.patch`);
	await Bun.write(normalizedArtifactPath, JSON.stringify(input.record, null, 2));
	const patch =
		input.operation === "append" ? `+ ${rendered}\n` : `- ${renderSourceRecord(existing!)}\n+ ${rendered}\n`;
	await Bun.write(patchArtifactPath, patch);
	return { registryPath: input.registryPath, normalizedArtifactPath, patchArtifactPath };
}
