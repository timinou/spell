import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import "@xterm/xterm/css/xterm.css";

export interface SpellTerminal {
	term: Terminal;
	fit: FitAddon;
	dispose: () => void;
}

/**
 * Build a styled xterm Terminal pre-wired with fit + web-links addons. The
 * theme tokens mirror the dashboard CSS so the terminal feels native to the
 * surrounding panel chrome.
 */
export function makeTerminal(): SpellTerminal {
	const term = new Terminal({
		cursorBlink: true,
		fontFamily: '"JetBrains Mono", "Cascadia Code", "Source Code Pro", ui-monospace, monospace',
		fontSize: 13,
		lineHeight: 1.2,
		scrollback: 5000,
		convertEol: true,
		theme: {
			background: "#010409",
			foreground: "#c9d1d9",
			cursor: "#58a6ff",
			selectionBackground: "#264F78",
			black: "#484f58",
			red: "#f85149",
			green: "#3fb950",
			yellow: "#d29922",
			blue: "#58a6ff",
			magenta: "#bc8cff",
			cyan: "#39d0d8",
			white: "#c9d1d9",
		},
	});
	const fit = new FitAddon();
	term.loadAddon(fit);
	term.loadAddon(new WebLinksAddon());
	let observer: ResizeObserver | null = null;
	return {
		term,
		fit,
		dispose() {
			observer?.disconnect();
			term.dispose();
		},
	};
}

export function attachTerminal(term: SpellTerminal, container: HTMLElement): () => void {
	term.term.open(container);
	const safeFit = () => {
		try {
			term.fit.fit();
		} catch {
			// container may be detached during transitions; ignore
		}
	};
	safeFit();
	const observer = new ResizeObserver(() => safeFit());
	observer.observe(container);
	return () => observer.disconnect();
}
