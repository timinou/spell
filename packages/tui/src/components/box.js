var _a;
import { applyBackgroundToLine, padding, visibleWidth } from "../utils";
/**
 * Box component - a container that applies padding and background to all children
 */
export class Box {
    #paddingX;
    #paddingY;
    #bgFn;
    #parent;
    // Cache for rendered output
    #cached;
    setParent(p) {
        this.#parent = p;
    }
    markDirty() {
        this.#cached = undefined;
        this.#parent?.markDirty();
    }
    constructor(paddingX = 1, paddingY = 1, bgFn) {
        this.children = [];
        this.#paddingX = paddingX;
        this.#paddingY = paddingY;
        this.#bgFn = bgFn;
    }
    addChild(component) {
        this.children.push(component);
        component.setParent?.(this);
        this.markDirty();
    }
    removeChild(component) {
        const index = this.children.indexOf(component);
        if (index !== -1) {
            this.children.splice(index, 1);
            component.setParent?.(undefined);
            this.markDirty();
        }
    }
    clear() {
        for (const child of this.children) {
            child.setParent?.(undefined);
        }
        this.children = [];
        this.markDirty();
    }
    setBgFn(bgFn) {
        this.#bgFn = bgFn;
        // Don't invalidate here - we'll detect bgFn changes by sampling output
    }
    #invalidateCache() {
        this.#cached = undefined;
    }
    static #tmp = new Uint32Array(2);
    #computeCacheKey(width, childLines, bgSample) {
        _a.#tmp[0] = width;
        _a.#tmp[1] = childLines.length;
        let h = Bun.hash.xxHash64(_a.#tmp);
        for (const line of childLines) {
            _a.#tmp[0] = line.length;
            h = Bun.hash.xxHash64(_a.#tmp, h);
            h = Bun.hash.xxHash64(line, h);
        }
        h = Bun.hash.xxHash64(bgSample ?? "", h);
        return h;
    }
    #matchCache(cacheKey) {
        return this.#cached?.key === cacheKey;
    }
    invalidate() {
        this.#invalidateCache();
        for (const child of this.children) {
            child.invalidate?.();
        }
        this.#parent?.markDirty();
    }
    render(width) {
        if (this.children.length === 0) {
            return [];
        }
        const contentWidth = Math.max(1, width - this.#paddingX * 2);
        const leftPad = padding(this.#paddingX);
        // Render all children
        const childLines = [];
        for (const child of this.children) {
            const lines = child.render(contentWidth);
            for (const line of lines) {
                childLines.push(leftPad + line);
            }
        }
        if (childLines.length === 0) {
            return [];
        }
        // Check if bgFn output changed by sampling
        const bgSample = this.#bgFn ? this.#bgFn("test") : undefined;
        const cacheKey = this.#computeCacheKey(width, childLines, bgSample);
        // Check cache validity
        if (this.#matchCache(cacheKey)) {
            return this.#cached.result;
        }
        // Apply background and padding
        const result = [];
        // Top padding
        for (let i = 0; i < this.#paddingY; i++) {
            result.push(this.#applyBg("", width));
        }
        // Content
        for (const line of childLines) {
            result.push(this.#applyBg(line, width));
        }
        // Bottom padding
        for (let i = 0; i < this.#paddingY; i++) {
            result.push(this.#applyBg("", width));
        }
        // Update cache
        this.#cached = { key: cacheKey, result };
        return result;
    }
    #applyBg(line, width) {
        const visLen = visibleWidth(line);
        const padNeeded = Math.max(0, width - visLen);
        const padded = line + padding(padNeeded);
        if (this.#bgFn) {
            return applyBackgroundToLine(padded, width, this.#bgFn);
        }
        return padded;
    }
}
_a = Box;
//# sourceMappingURL=box.js.map