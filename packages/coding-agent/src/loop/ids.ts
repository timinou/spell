function slugify(value: string): string {
	return value
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 48);
}

export function createLoopId(name: string, now = Date.now()): string {
	const slug = slugify(name) || "loop";
	return `LOOP-${now}-${slug}`;
}
