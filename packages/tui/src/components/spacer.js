/**
 * Spacer component that renders empty lines
 */
export class Spacer {
    #lines;
    #parent;
    constructor(lines = 1) {
        this.#lines = lines;
    }
    setParent(p) {
        this.#parent = p;
    }
    setLines(lines) {
        this.#lines = lines;
        this.#parent?.markDirty();
    }
    invalidate() {
        this.#parent?.markDirty();
    }
    render(_width) {
        const result = [];
        for (let i = 0; i < this.#lines; i++) {
            result.push("");
        }
        return result;
    }
}
//# sourceMappingURL=spacer.js.map