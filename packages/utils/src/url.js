export function normalizeCanonicalUrl(url) {
    try {
        const parsed = new URL(url);
        for (const key of [...parsed.searchParams.keys()]) {
            if (key.startsWith("utm_") || key === "ref" || key === "source") {
                parsed.searchParams.delete(key);
            }
        }
        parsed.hash = "";
        if (parsed.searchParams.toString() === "") {
            parsed.search = "";
        }
        return parsed.toString();
    }
    catch {
        return undefined;
    }
}
export function normalizePublishedAt(publishedAt) {
    const trimmed = publishedAt?.trim();
    if (!trimmed) {
        return undefined;
    }
    if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
        return `${trimmed}T00:00:00.000Z`;
    }
    const parsed = new Date(trimmed);
    return Number.isNaN(parsed.getTime()) ? undefined : parsed.toISOString();
}
//# sourceMappingURL=url.js.map