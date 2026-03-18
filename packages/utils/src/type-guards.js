export function isRecord(value) {
    return !!value && typeof value === "object" && !Array.isArray(value);
}
export function asRecord(value) {
    return isRecord(value) ? value : null;
}
export function toError(value) {
    return value instanceof Error ? value : new Error(String(value));
}
//# sourceMappingURL=type-guards.js.map