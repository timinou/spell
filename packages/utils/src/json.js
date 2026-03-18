/**
 * Try to parse JSON, returning null on failure.
 */
export function tryParseJson(content) {
    try {
        return JSON.parse(content);
    }
    catch {
        return null;
    }
}
//# sourceMappingURL=json.js.map