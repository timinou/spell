import { sliceByColumn, visibleWidth } from "../utils";
import { Text } from "./text";
/**
 * Loader component that updates every 80ms with spinning animation
 */
export class Loader extends Text {
    #frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
    #currentFrame = 0;
    #intervalId;
    #ui = null;
    constructor(ui, spinnerColorFn, messageColorFn, message = "Loading...", spinnerFrames) {
        super("", 1, 0);
        this.spinnerColorFn = spinnerColorFn;
        this.messageColorFn = messageColorFn;
        this.message = message;
        this.#ui = ui;
        if (spinnerFrames && spinnerFrames.length > 0) {
            this.#frames = spinnerFrames;
        }
        this.start();
    }
    render(width) {
        const lines = ["", ...super.render(width)];
        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            if (visibleWidth(line) > width) {
                lines[i] = sliceByColumn(line, 0, width, true);
            }
        }
        return lines;
    }
    start() {
        this.#updateDisplay();
        this.#intervalId = setInterval(() => {
            this.#currentFrame = (this.#currentFrame + 1) % this.#frames.length;
            this.#updateDisplay();
        }, 80);
    }
    stop() {
        if (this.#intervalId) {
            clearInterval(this.#intervalId);
            this.#intervalId = undefined;
        }
    }
    setMessage(message) {
        this.message = message;
        this.#updateDisplay();
    }
    #updateDisplay() {
        const frame = this.#frames[this.#currentFrame];
        this.setText(`${this.spinnerColorFn(frame)} ${this.messageColorFn(this.message)}`);
        if (this.#ui) {
            this.#ui.requestRender();
        }
    }
}
//# sourceMappingURL=loader.js.map