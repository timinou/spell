import { parse } from "@bgotink/kdl";
import type { ChannelsConfig } from "./types";

export function parseChannelsConfig(kdlText: string): ChannelsConfig {
	const document = parse(kdlText);
	const telegramNode = document.findNodeByName("telegram");
	if (!telegramNode) {
		return {};
	}

	let botToken: string | undefined;
	let owners: number[] | undefined;

	for (const child of telegramNode.children?.nodes ?? []) {
		if (child.getName() === "bot-token") {
			const value = child.getArgument(0);
			if (typeof value !== "string" || value.length === 0) {
				throw new Error("channels.telegram.botToken must have a non-empty string argument");
			}
			botToken = value;
			continue;
		}
		if (child.getName() === "owners") {
			const values = child.getArguments();
			if (!values.every(value => typeof value === "number" && Number.isFinite(value))) {
				throw new Error("channels.telegram.owners must contain only numeric chat ids");
			}
			owners = values as number[];
		}
	}
	if (!botToken && !owners) {
		return {};
	}
	if (!botToken) {
		throw new Error("channels.telegram.botToken is required");
	}
	if (!owners) {
		throw new Error("channels.telegram.owners is required");
	}

	return { telegram: { botToken, owners } };
}
