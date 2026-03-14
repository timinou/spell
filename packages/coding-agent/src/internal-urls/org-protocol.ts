/**
 * Protocol handler for org:// URLs.
 *
 * org://ITEM-ID resolves to the body of the org item with that CUSTOM_ID.
 * CUSTOM_IDs are globally unique across categories, so no category prefix is needed.
 *
 * URL forms:
 * - org://ITEM-ID — reads the body of the specified org item
 */

import { findItemById, resolveCategories } from "@oh-my-pi/pi-org";
import type { Settings } from "../config/settings";
import { buildOrgConfig } from "../plan-mode/org-plan";
import type { InternalResource, InternalUrl, ProtocolHandler } from "./types";

export interface OrgProtocolOptions {
	getSettings: () => Settings;
	getCwd: () => string;
}

export class OrgProtocolHandler implements ProtocolHandler {
	readonly scheme = "org";

	constructor(private readonly options: OrgProtocolOptions) {}

	async resolve(url: InternalUrl): Promise<InternalResource> {
		const settings = this.options.getSettings();

		if (!settings.get("org.enabled")) {
			throw new Error("org:// URLs require org to be enabled (org.enabled = true).");
		}

		// The CUSTOM_ID is in the host segment: org://ITEM-ID
		const itemId = url.rawHost || url.hostname;
		if (!itemId) {
			throw new Error("org:// URL requires an item ID: org://ITEM-ID");
		}

		const config = buildOrgConfig(settings);
		const projectRoot = this.options.getCwd();
		const categories = resolveCategories(config, projectRoot);
		const catDirs = categories.map(c => ({ absPath: c.absPath, name: c.name, dir: c.dirName }));

		const item = await findItemById(catDirs, itemId, config.todoKeywords);
		if (!item) {
			throw new Error(`Org item not found: ${itemId}`);
		}

		const content = item.body ?? "";
		return {
			url: url.href,
			content,
			contentType: "text/x-org",
			size: Buffer.byteLength(content, "utf-8"),
			sourcePath: item.file,
			notes: [`Org item: ${item.title ?? itemId} (${itemId})`],
		};
	}
}
