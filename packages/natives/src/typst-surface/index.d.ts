import type { TypstHitTestResult, TypstSurfaceSessionOptions, TypstSurfaceState, TypstViewport } from "./types";
export type { TypstBackendCapability, TypstBlockKind, TypstBlockModel, TypstEditableHit, TypstHitError, TypstHitTestResult, TypstLayoutBounds, TypstNoneditableHit, TypstOutsideHit, TypstPageMetric, TypstRenderDiagnostic, TypstSourceSpan, TypstSurfaceSessionNative, TypstSurfaceSessionOptions, TypstSurfaceState, TypstUnsupportedReason, TypstViewport, } from "./types";
export declare class TypstSurfaceSession {
    #private;
    constructor(options?: TypstSurfaceSessionOptions);
    get state(): TypstSurfaceState;
    setDocument(source: string): TypstSurfaceState;
    setViewport(viewport: TypstViewport): TypstSurfaceState;
    hitTest(x: number, y: number): TypstHitTestResult;
    snapshotSvg(): string;
}
//# sourceMappingURL=index.d.ts.map