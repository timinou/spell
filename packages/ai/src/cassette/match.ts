import { createHash } from "node:crypto";

function stableStringify(obj: unknown): string {
	return JSON.stringify(obj, (_key, value) => {
		if (value && typeof value === "object" && !Array.isArray(value)) {
			return Object.keys(value)
				.sort()
				.reduce((sorted, k) => {
					sorted[k] = (value as Record<string, unknown>)[k];
					return sorted;
				}, {} as Record<string, unknown>);
		}
		return value;
	});
}

function normalizeBody(contentType: string | null, body: string): string {
	if (!contentType || !contentType.includes("application/json")) {
		return body;
	}
	try {
		return stableStringify(JSON.parse(body));
	} catch {
		return body;
	}
}

export async function defaultFingerprint(req: Request): Promise<string> {
	const url = req.url.replace(/\/+$/, "");
	const body = await req.clone().text();
	const normalized = normalizeBody(req.headers.get("content-type"), body);
	const hash = createHash("sha256");
	hash.update(req.method + "\n" + url + "\n" + normalized);
	return "sha256:" + hash.digest("hex");
}
