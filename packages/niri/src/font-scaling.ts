/**
 * OSC 50 font scaling utilities.
 *
 * OSC 50 is an xterm extension for querying and setting the terminal font.
 * Support is spotty: xterm supports it; Ghostty and kitty may not.
 * All operations degrade gracefully — failures are logged and swallowed.
 *
 * Font strings look like:  xft:Iosevka:size=14
 * We scale by bumping the `size=N` component.
 */

const OSC_QUERY = "\x1b]50;?\x1b\\";
const QUERY_TIMEOUT_MS = 200;

/** Parse the font-size value from an xft font string. Returns NaN on failure. */
function parseSize(font: string): number {
	const m = font.match(/size=(\d+(?:\.\d+)?)/);
	return m ? parseFloat(m[1]) : NaN;
}

/** Replace (or append) size=N in a font string. */
function replaceSize(font: string, newSize: number): string {
	const rounded = Math.round(newSize);
	if (/size=\d+(?:\.\d+)?/.test(font)) {
		return font.replace(/size=\d+(?:\.\d+)?/, `size=${rounded}`);
	}
	return `${font}:size=${rounded}`;
}

/**
 * Send an OSC 50 query and wait up to QUERY_TIMEOUT_MS for the terminal to
 * echo back the current font string. Returns null if unsupported or timeout.
 *
 * Terminal responds with:  OSC 50 ; <font> ST  (ST = \x1b\\)
 */
export function queryCurrentFont(): Promise<string | null> {
	// Without a TTY stdin we cannot receive the terminal's DSR reply.
	if (!process.stdin.isTTY) return Promise.resolve(null);
	const { promise, resolve } = Promise.withResolvers<string | null>();
	let settled = false;

	const timer = setTimeout(() => {
		if (settled) return;
		settled = true;
		cleanup();
		resolve(null);
	}, QUERY_TIMEOUT_MS);

	let accumulated = "";

	const onData = (chunk: Buffer) => {
		accumulated += chunk.toString("utf8");
		// Look for OSC 50 ; <font> ST pattern: \x1b]50;<font>\x1b\\ or \x1b]50;<font>\x07
		const m = accumulated.match(/\x1b\]50;([^\x1b\x07]+)(?:\x1b\\|\x07)/);
		if (m) {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			cleanup();
			resolve(m[1]);
		}
	};

	const cleanup = () => {
		process.stdin.removeListener("data", onData);
		// Restore normal stdin mode if we temporarily made it raw
		if (process.stdin.isTTY && wasRaw === false) {
			process.stdin.setRawMode(false);
		}
	};

	// stdin must be in raw mode to receive the terminal's DSR reply
	let wasRaw = false;
	if (process.stdin.isTTY) {
		wasRaw = process.stdin.isRaw;
		if (!wasRaw) {
			process.stdin.setRawMode(true);
		}
	}

	process.stdin.on("data", onData);
	process.stdout.write(OSC_QUERY);

	return promise;
}

/** Send an OSC 50 set command to change the terminal font. */
export function setFont(font: string): void {
	process.stdout.write(`\x1b]50;${font}\x1b\\`);
}

/**
 * Query the current font, increase its size by scaleFactor, and apply the
 * enlarged font. Returns a restore function that reverts to the original.
 * Returns null if font scaling is unsupported or the font string is unparseable.
 */
export async function withLargerFont(scaleFactor: number): Promise<(() => void) | null> {
	let originalFont: string | null;
	try {
		originalFont = await queryCurrentFont();
	} catch {
		return null;
	}
	if (originalFont === null) return null;

	const originalSize = parseSize(originalFont);
	if (Number.isNaN(originalSize)) return null;

	const newSize = Math.round(originalSize * scaleFactor);
	const enlargedFont = replaceSize(originalFont, newSize);

	try {
		setFont(enlargedFont);
	} catch {
		return null;
	}

	return () => {
		try {
			setFont(originalFont!);
		} catch {
			// Best-effort — nothing to propagate
		}
	};
}
