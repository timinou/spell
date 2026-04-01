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
	if (interactiveSurface === "qml" && options.displayAvailable) {
		return { kind: "interactive-qml" };
	}
	return { kind: "interactive-tui" };
}
