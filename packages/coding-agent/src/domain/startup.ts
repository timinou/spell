import type { Mode } from "../cli/args";
import type { SpellDomain } from "./loader";

type PrintRouteMode = Exclude<Mode, "rpc">;

export type StartupRoute =
	| { kind: "canvas"; canvasName: string }
	| { kind: "canvas-display-required" }
	| { kind: "interactive-qml" }
	| { kind: "interactive-tui" }
	| { kind: "print"; mode: PrintRouteMode }
	| { kind: "rpc" };

export interface ResolveStartupRouteOptions {
	canvas?: string;
	displayAvailable: boolean;
	domainManifest?: SpellDomain;
	hasPipedInput: boolean;
	mode?: Mode;
	print?: boolean;
}

export function resolveStartupRoute(options: ResolveStartupRouteOptions): StartupRoute {
	const autoPrint = options.hasPipedInput && !options.print && options.mode === undefined;
	if (options.canvas) {
		return options.displayAvailable
			? { kind: "canvas", canvasName: options.canvas }
			: { kind: "canvas-display-required" };
	}
	if (options.mode === "rpc") {
		return { kind: "rpc" };
	}
	if (options.print || autoPrint || options.mode !== undefined) {
		return { kind: "print", mode: options.mode ?? "text" };
	}
	const interactiveSurface = options.domainManifest?.interactiveSurface ?? "tui";
	// A headless/autonomous domain (`surface "none"`) has no human present:
	// with no explicit mode/canvas/pipe above, fall through to one-shot print
	// rather than launching an interactive TUI that would block on input.
	if (interactiveSurface === "none") {
		return { kind: "print", mode: "text" };
	}
	if (interactiveSurface === "qml" && options.displayAvailable) {
		return { kind: "interactive-qml" };
	}
	return { kind: "interactive-tui" };
}
