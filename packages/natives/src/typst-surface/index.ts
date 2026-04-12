import { native } from "../native";
import type {
	TypstHitTestResult,
	TypstSurfaceJsonCodec,
	TypstSurfaceSessionNative,
	TypstSurfaceSessionOptions,
	TypstSurfaceState,
	TypstViewport,
} from "./types";

export type {
	TypstBackendCapability,
	TypstBlockKind,
	TypstBlockModel,
	TypstEditableHit,
	TypstHitError,
	TypstHitTestResult,
	TypstLayoutBounds,
	TypstNoneditableHit,
	TypstOutsideHit,
	TypstPageMetric,
	TypstRenderDiagnostic,
	TypstSourceSpan,
	TypstSurfaceSessionNative,
	TypstSurfaceSessionOptions,
	TypstSurfaceState,
	TypstUnsupportedReason,
	TypstViewport,
} from "./types";

const codec: TypstSurfaceJsonCodec = {
	parseState(json): TypstSurfaceState {
		return decodeJson<TypstSurfaceState>(json);
	},
	parseHit(json): TypstHitTestResult {
		const value = decodeJson<Record<string, unknown>>(json);
		if (value.kind === "editable-span" && value.block_kind && !value.blockKind) {
			value.blockKind = value.block_kind;
		}
		if (value.kind === "noneditable-preview" && value.block_kind && !value.blockKind) {
			value.blockKind = value.block_kind;
		}
		return value as unknown as TypstHitTestResult;
	},
};

function decodeJson<T>(json: string): T {
	return JSON.parse(json) as T;
}

export class TypstSurfaceSession {
	#native: TypstSurfaceSessionNative;
	#state: TypstSurfaceState;

	constructor(options: TypstSurfaceSessionOptions = {}) {
		this.#native = new native.TypstSurfaceSessionNative(options.forceDegraded ?? false);
		this.#state = codec.parseState(this.#native.getState());
	}

	get state(): TypstSurfaceState {
		return this.#state;
	}

	setDocument(source: string): TypstSurfaceState {
		this.#state = codec.parseState(this.#native.setDocument(source));
		return this.#state;
	}

	setViewport(viewport: TypstViewport): TypstSurfaceState {
		this.#state = codec.parseState(this.#native.setViewport(viewport));
		return this.#state;
	}

	hitTest(x: number, y: number): TypstHitTestResult {
		return codec.parseHit(this.#native.hitTest(x, y));
	}

	snapshotSvg(): string {
		return this.#native.snapshotSvg();
	}
}
