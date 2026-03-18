export function hookFetch(handler) {
    const original = globalThis.fetch;
    globalThis.fetch = ((input, init) => handler(input, init, original));
    return {
        [Symbol.dispose]() {
            globalThis.fetch = original;
        },
    };
}
//# sourceMappingURL=hook-fetch.js.map