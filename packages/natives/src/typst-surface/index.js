import { native } from "../native";
const codec = {
    parseState(json) {
        return decodeJson(json);
    },
    parseHit(json) {
        const value = decodeJson(json);
        if (value.kind === "editable-span" && value.block_kind && !value.blockKind) {
            value.blockKind = value.block_kind;
        }
        if (value.kind === "noneditable-preview" && value.block_kind && !value.blockKind) {
            value.blockKind = value.block_kind;
        }
        return value;
    },
};
function decodeJson(json) {
    return JSON.parse(json);
}
export class TypstSurfaceSession {
    #native;
    #state;
    constructor(options = {}) {
        this.#native = new native.TypstSurfaceSessionNative(options.forceDegraded ?? false);
        this.#state = codec.parseState(this.#native.getState());
    }
    get state() {
        return this.#state;
    }
    setDocument(source) {
        this.#state = codec.parseState(this.#native.setDocument(source));
        return this.#state;
    }
    setViewport(viewport) {
        this.#state = codec.parseState(this.#native.setViewport(viewport));
        return this.#state;
    }
    hitTest(x, y) {
        return codec.parseHit(this.#native.hitTest(x, y));
    }
    snapshotSvg() {
        return this.#native.snapshotSvg();
    }
}
//# sourceMappingURL=index.js.map