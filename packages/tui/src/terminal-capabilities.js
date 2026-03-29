import { encodeSixel } from "@oh-my-pi/pi-natives";
import { $env } from "@oh-my-pi/pi-utils";
export var ImageProtocol;
(function (ImageProtocol) {
    ImageProtocol["Kitty"] = "\u001B_G";
    ImageProtocol["Iterm2"] = "\u001B]1337;File=";
    ImageProtocol["Sixel"] = "\u001BPq";
})(ImageProtocol || (ImageProtocol = {}));
export var NotifyProtocol;
(function (NotifyProtocol) {
    NotifyProtocol["Bell"] = "\u0007";
    NotifyProtocol["Osc99"] = "\u001B]99;;";
    NotifyProtocol["Osc9"] = "\u001B]9;";
})(NotifyProtocol || (NotifyProtocol = {}));
const SIXEL_DCS_START_REGEX = /\x1bP(?:[0-9;]*)q/u;
/** Terminal capability details used for rendering and protocol selection. */
export class TerminalInfo {
    constructor(id, imageProtocol, trueColor, hyperlinks, notifyProtocol = NotifyProtocol.Bell) {
        this.id = id;
        this.imageProtocol = imageProtocol;
        this.trueColor = trueColor;
        this.hyperlinks = hyperlinks;
        this.notifyProtocol = notifyProtocol;
    }
    isImageLine(line) {
        if (!this.imageProtocol)
            return false;
        if (this.imageProtocol === ImageProtocol.Sixel) {
            return SIXEL_DCS_START_REGEX.test(line.slice(0, 128));
        }
        return line.slice(0, 64).includes(this.imageProtocol);
    }
    formatNotification(message) {
        if (this.notifyProtocol === NotifyProtocol.Bell) {
            return NotifyProtocol.Bell;
        }
        return `${this.notifyProtocol}${message}\x1b\\`;
    }
    sendNotification(message) {
        if (isNotificationSuppressed())
            return;
        process.stdout.write(this.formatNotification(message));
    }
}
export function isNotificationSuppressed() {
    const value = $env.PI_NOTIFICATIONS;
    if (!value)
        return false;
    return value === "off" || value === "0" || value === "false";
}
function getForcedImageProtocol() {
    const raw = $env.PI_FORCE_IMAGE_PROTOCOL?.trim().toLowerCase();
    if (!raw)
        return undefined;
    if (raw === "kitty")
        return ImageProtocol.Kitty;
    if (raw === "iterm2" || raw === "iterm")
        return ImageProtocol.Iterm2;
    if (raw === "sixel")
        return ImageProtocol.Sixel;
    if (raw === "off" || raw === "none" || raw === "0" || raw === "false")
        return null;
    return null;
}
function parseMajorMinorVersion(versionRaw) {
    if (!versionRaw)
        return null;
    const match = /^(\d+)\.(\d+)/u.exec(versionRaw.trim());
    if (!match)
        return null;
    const major = Number.parseInt(match[1] ?? "", 10);
    const minor = Number.parseInt(match[2] ?? "", 10);
    if (!Number.isFinite(major) || !Number.isFinite(minor))
        return null;
    return { major, minor };
}
/**
 * Returns true when running in Windows Terminal with known SIXEL support.
 *
 * Windows Terminal introduced SIXEL support in preview 1.22.
 */
export function isWindowsTerminalPreviewSixelSupported(env = Bun.env, platform = process.platform) {
    if (platform !== "win32")
        return false;
    if (!env.WT_SESSION)
        return false;
    if (env.TERM_PROGRAM && env.TERM_PROGRAM.toLowerCase() !== "windows_terminal") {
        return false;
    }
    const version = parseMajorMinorVersion(env.TERM_PROGRAM_VERSION);
    if (!version)
        return false;
    return version.major > 1 || (version.major === 1 && version.minor >= 22);
}
function getFallbackImageProtocol(terminalId) {
    if (!process.stdout.isTTY)
        return null;
    if (terminalId === "vscode" || terminalId === "alacritty")
        return null;
    const term = Bun.env.TERM?.toLowerCase() ?? "";
    if (term.includes("screen") || term.includes("tmux") || term.includes("ghostty")) {
        return ImageProtocol.Kitty;
    }
    return null;
}
const KNOWN_TERMINALS = Object.freeze({
    // Fallback terminals
    base: new TerminalInfo("base", null, false, true, NotifyProtocol.Bell),
    trueColor: new TerminalInfo("trueColor", null, true, true, NotifyProtocol.Bell),
    // Recognized terminals
    kitty: new TerminalInfo("kitty", ImageProtocol.Kitty, true, true, NotifyProtocol.Osc99),
    ghostty: new TerminalInfo("ghostty", ImageProtocol.Kitty, true, true, NotifyProtocol.Osc9),
    wezterm: new TerminalInfo("wezterm", ImageProtocol.Kitty, true, true, NotifyProtocol.Osc9),
    iterm2: new TerminalInfo("iterm2", ImageProtocol.Iterm2, true, true, NotifyProtocol.Osc9),
    vscode: new TerminalInfo("vscode", null, true, true, NotifyProtocol.Bell),
    alacritty: new TerminalInfo("alacritty", null, true, true, NotifyProtocol.Bell),
});
export const TERMINAL_ID = (() => {
    function caseEq(a, b) {
        return a.toLowerCase() === b.toLowerCase(); // For compiler to pattern match
    }
    const { KITTY_WINDOW_ID, GHOSTTY_RESOURCES_DIR, WEZTERM_PANE, ITERM_SESSION_ID, VSCODE_PID, ALACRITTY_WINDOW_ID, TERM_PROGRAM, TERM, COLORTERM, } = Bun.env;
    if (KITTY_WINDOW_ID)
        return "kitty";
    if (GHOSTTY_RESOURCES_DIR)
        return "ghostty";
    if (WEZTERM_PANE)
        return "wezterm";
    if (ITERM_SESSION_ID)
        return "iterm2";
    if (VSCODE_PID)
        return "vscode";
    if (ALACRITTY_WINDOW_ID)
        return "alacritty";
    if (TERM_PROGRAM) {
        if (caseEq(TERM_PROGRAM, "kitty"))
            return "kitty";
        if (caseEq(TERM_PROGRAM, "ghostty"))
            return "ghostty";
        if (caseEq(TERM_PROGRAM, "wezterm"))
            return "wezterm";
        if (caseEq(TERM_PROGRAM, "iterm.app"))
            return "iterm2";
        if (caseEq(TERM_PROGRAM, "vscode"))
            return "vscode";
        if (caseEq(TERM_PROGRAM, "alacritty"))
            return "alacritty";
    }
    if (!!TERM && TERM.toLowerCase().includes("ghostty"))
        return "ghostty";
    if (COLORTERM) {
        if (caseEq(COLORTERM, "truecolor") || caseEq(COLORTERM, "24bit"))
            return "trueColor";
    }
    return "base";
})();
export const TERMINAL = (() => {
    const terminal = getTerminalInfo(TERMINAL_ID);
    const forcedImageProtocol = getForcedImageProtocol();
    if (forcedImageProtocol !== undefined) {
        return new TerminalInfo(terminal.id, forcedImageProtocol, terminal.trueColor, terminal.hyperlinks, terminal.notifyProtocol);
    }
    if (!terminal.imageProtocol) {
        const fallbackImageProtocol = getFallbackImageProtocol(terminal.id);
        if (fallbackImageProtocol) {
            return new TerminalInfo(terminal.id, fallbackImageProtocol, terminal.trueColor, terminal.hyperlinks, terminal.notifyProtocol);
        }
    }
    return terminal;
})();
const KITTY_DELETE_ALL_IMAGES = "\x1b_Ga=d;\x1b\\";
/**
 * Override terminal image protocol at runtime after capability probes complete.
 */
export function setTerminalImageProtocol(imageProtocol) {
    TERMINAL.imageProtocol = imageProtocol;
}
/**
 * Clear visible image placements from the terminal before rendering text-only overlays.
 * Kitty placements float above text, so they must be explicitly deleted.
 */
export function clearImagePlacements() {
    if (!process.stdout.isTTY)
        return;
    if (TERMINAL.imageProtocol !== ImageProtocol.Kitty)
        return;
    process.stdout.write(KITTY_DELETE_ALL_IMAGES);
}
export function getTerminalInfo(terminalId) {
    return KNOWN_TERMINALS[terminalId];
}
// Default cell dimensions - updated by TUI when terminal responds to query
let cellDimensions = { widthPx: 9, heightPx: 18 };
export function getCellDimensions() {
    return cellDimensions;
}
export function setCellDimensions(dims) {
    cellDimensions = dims;
}
export function encodeKitty(base64Data, options = {}) {
    const CHUNK_SIZE = 4096;
    const params = ["a=T", "f=100", "q=2"];
    if (options.columns)
        params.push(`c=${options.columns}`);
    if (options.rows)
        params.push(`r=${options.rows}`);
    if (options.imageId)
        params.push(`i=${options.imageId}`);
    if (base64Data.length <= CHUNK_SIZE) {
        return `\x1b_G${params.join(",")};${base64Data}\x1b\\`;
    }
    const chunks = [];
    let offset = 0;
    let isFirst = true;
    while (offset < base64Data.length) {
        const chunk = base64Data.slice(offset, offset + CHUNK_SIZE);
        const isLast = offset + CHUNK_SIZE >= base64Data.length;
        if (isFirst) {
            chunks.push(`\x1b_G${params.join(",")},m=1;${chunk}\x1b\\`);
            isFirst = false;
        }
        else if (isLast) {
            chunks.push(`\x1b_Gm=0;${chunk}\x1b\\`);
        }
        else {
            chunks.push(`\x1b_Gm=1;${chunk}\x1b\\`);
        }
        offset += CHUNK_SIZE;
    }
    return chunks.join("");
}
export function encodeITerm2(base64Data, options = {}) {
    const params = [`inline=${options.inline !== false ? 1 : 0}`];
    if (options.width !== undefined)
        params.push(`width=${options.width}`);
    if (options.height !== undefined)
        params.push(`height=${options.height}`);
    if (options.name) {
        const nameBase64 = Buffer.from(options.name).toBase64();
        params.push(`name=${nameBase64}`);
    }
    if (options.preserveAspectRatio === false) {
        params.push("preserveAspectRatio=0");
    }
    return `\x1b]1337;File=${params.join(";")}:${base64Data}\x07`;
}
export function calculateImageRows(imageDimensions, targetWidthCells, cellDimensions = { widthPx: 9, heightPx: 18 }) {
    const targetWidthPx = targetWidthCells * cellDimensions.widthPx;
    const scale = targetWidthPx / imageDimensions.widthPx;
    const scaledHeightPx = imageDimensions.heightPx * scale;
    const rows = Math.ceil(scaledHeightPx / cellDimensions.heightPx);
    return Math.max(1, rows);
}
function calculateImageFit(imageDimensions, options, cellDims) {
    const maxColumns = options.maxWidthCells !== undefined ? Math.max(1, Math.floor(options.maxWidthCells)) : undefined;
    const maxRows = options.maxHeightCells !== undefined ? Math.max(1, Math.floor(options.maxHeightCells)) : undefined;
    if (maxColumns === undefined && maxRows === undefined) {
        const columns = Math.max(1, Math.ceil(imageDimensions.widthPx / cellDims.widthPx));
        const rows = Math.max(1, Math.ceil(imageDimensions.heightPx / cellDims.heightPx));
        return { columns, rows };
    }
    const maxWidthPx = maxColumns !== undefined ? maxColumns * cellDims.widthPx : Number.POSITIVE_INFINITY;
    const maxHeightPx = maxRows !== undefined ? maxRows * cellDims.heightPx : Number.POSITIVE_INFINITY;
    const scale = Math.min(maxWidthPx / imageDimensions.widthPx, maxHeightPx / imageDimensions.heightPx);
    const fittedWidthPx = imageDimensions.widthPx * scale;
    const fittedHeightPx = imageDimensions.heightPx * scale;
    const columns = Math.max(1, Math.floor(fittedWidthPx / cellDims.widthPx));
    const rows = Math.max(1, Math.ceil(fittedHeightPx / cellDims.heightPx));
    return {
        columns: maxColumns !== undefined ? Math.min(columns, maxColumns) : columns,
        rows: maxRows !== undefined ? Math.min(rows, maxRows) : rows,
    };
}
export function getPngDimensions(base64Data) {
    try {
        const buffer = Buffer.from(base64Data, "base64");
        if (buffer.length < 24) {
            return null;
        }
        if (buffer[0] !== 0x89 || buffer[1] !== 0x50 || buffer[2] !== 0x4e || buffer[3] !== 0x47) {
            return null;
        }
        const width = buffer.readUInt32BE(16);
        const height = buffer.readUInt32BE(20);
        return { widthPx: width, heightPx: height };
    }
    catch {
        return null;
    }
}
export function getJpegDimensions(base64Data) {
    try {
        const buffer = Buffer.from(base64Data, "base64");
        if (buffer.length < 2) {
            return null;
        }
        if (buffer[0] !== 0xff || buffer[1] !== 0xd8) {
            return null;
        }
        let offset = 2;
        while (offset < buffer.length - 9) {
            if (buffer[offset] !== 0xff) {
                offset++;
                continue;
            }
            const marker = buffer[offset + 1];
            if (marker >= 0xc0 && marker <= 0xc2) {
                const height = buffer.readUInt16BE(offset + 5);
                const width = buffer.readUInt16BE(offset + 7);
                return { widthPx: width, heightPx: height };
            }
            if (offset + 3 >= buffer.length) {
                return null;
            }
            const length = buffer.readUInt16BE(offset + 2);
            if (length < 2) {
                return null;
            }
            offset += 2 + length;
        }
        return null;
    }
    catch {
        return null;
    }
}
export function getGifDimensions(base64Data) {
    try {
        const buffer = Buffer.from(base64Data, "base64");
        if (buffer.length < 10) {
            return null;
        }
        const sig = buffer.slice(0, 6).toString("ascii");
        if (sig !== "GIF87a" && sig !== "GIF89a") {
            return null;
        }
        const width = buffer.readUInt16LE(6);
        const height = buffer.readUInt16LE(8);
        return { widthPx: width, heightPx: height };
    }
    catch {
        return null;
    }
}
export function getWebpDimensions(base64Data) {
    try {
        const buffer = Buffer.from(base64Data, "base64");
        if (buffer.length < 30) {
            return null;
        }
        const riff = buffer.slice(0, 4).toString("ascii");
        const webp = buffer.slice(8, 12).toString("ascii");
        if (riff !== "RIFF" || webp !== "WEBP") {
            return null;
        }
        const chunk = buffer.slice(12, 16).toString("ascii");
        if (chunk === "VP8 ") {
            if (buffer.length < 30)
                return null;
            const width = buffer.readUInt16LE(26) & 0x3fff;
            const height = buffer.readUInt16LE(28) & 0x3fff;
            return { widthPx: width, heightPx: height };
        }
        else if (chunk === "VP8L") {
            if (buffer.length < 25)
                return null;
            const bits = buffer.readUInt32LE(21);
            const width = (bits & 0x3fff) + 1;
            const height = ((bits >> 14) & 0x3fff) + 1;
            return { widthPx: width, heightPx: height };
        }
        else if (chunk === "VP8X") {
            if (buffer.length < 30)
                return null;
            const width = (buffer[24] | (buffer[25] << 8) | (buffer[26] << 16)) + 1;
            const height = (buffer[27] | (buffer[28] << 8) | (buffer[29] << 16)) + 1;
            return { widthPx: width, heightPx: height };
        }
        return null;
    }
    catch {
        return null;
    }
}
export function getImageDimensions(base64Data, mimeType) {
    if (mimeType === "image/png") {
        return getPngDimensions(base64Data);
    }
    if (mimeType === "image/jpeg") {
        return getJpegDimensions(base64Data);
    }
    if (mimeType === "image/gif") {
        return getGifDimensions(base64Data);
    }
    if (mimeType === "image/webp") {
        return getWebpDimensions(base64Data);
    }
    return null;
}
export function renderImage(base64Data, imageDimensions, options = {}) {
    if (!TERMINAL.imageProtocol) {
        return null;
    }
    const cellDims = getCellDimensions();
    const fit = calculateImageFit(imageDimensions, options, cellDims);
    if (TERMINAL.imageProtocol === ImageProtocol.Kitty) {
        const sequence = encodeKitty(base64Data, {
            columns: fit.columns,
            rows: fit.rows,
        });
        return { sequence, rows: fit.rows };
    }
    if (TERMINAL.imageProtocol === ImageProtocol.Sixel) {
        try {
            const targetWidthPx = Math.max(1, fit.columns * cellDims.widthPx);
            const targetHeightPx = Math.max(1, fit.rows * cellDims.heightPx);
            const decoded = new Uint8Array(Buffer.from(base64Data, "base64"));
            const sequence = encodeSixel(decoded, targetWidthPx, targetHeightPx);
            return { sequence, rows: fit.rows };
        }
        catch {
            return null;
        }
    }
    if (TERMINAL.imageProtocol === ImageProtocol.Iterm2) {
        const sequence = encodeITerm2(base64Data, {
            width: fit.columns,
            height: "auto",
            preserveAspectRatio: options.preserveAspectRatio ?? true,
        });
        return { sequence, rows: fit.rows };
    }
    return null;
}
export function imageFallback(mimeType, dimensions, filename) {
    const parts = [];
    if (filename)
        parts.push(filename);
    parts.push(`[${mimeType}]`);
    if (dimensions)
        parts.push(`${dimensions.widthPx}x${dimensions.heightPx}`);
    return `[Image: ${parts.join(" ")}]`;
}
//# sourceMappingURL=terminal-capabilities.js.map