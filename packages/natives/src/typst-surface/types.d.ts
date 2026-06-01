import type { TsFunc } from "../bindings";
export type TypstBackendCapability = "interactive" | "mixed" | "preview_only" | "recovery_only" | "failed";
export type TypstUnsupportedReason = "forced_fallback" | "unsupported_syntax" | "syntax_error" | "unsupported_block" | "renderer_unavailable" | "stale_mapping";
export type TypstBlockKind = "heading" | "paragraph" | "list_item" | "image" | "table" | "variable" | "unsupported";
export interface TypstViewport {
    width: number;
    height: number;
    zoom: number;
    scrollX: number;
    scrollY: number;
}
export interface TypstSourceSpan {
    anchor: string;
    startLine: number;
    endLine: number;
    startColumn: number;
    endColumn: number;
}
export interface TypstLayoutBounds {
    page: number;
    x: number;
    y: number;
    width: number;
    height: number;
}
export interface TypstPageMetric {
    page: number;
    width: number;
    height: number;
    blocks: number;
    ready: boolean;
}
export interface TypstRenderDiagnostic {
    code: string;
    message: string;
    line?: number;
}
export interface TypstBlockModel {
    anchor: string;
    kind: TypstBlockKind;
    text: string;
    span: TypstSourceSpan;
    bounds: TypstLayoutBounds;
    editable: boolean;
    reason?: TypstUnsupportedReason;
    level?: number;
    meta: unknown;
}
export interface TypstSurfaceState {
    ready: boolean;
    degraded: boolean;
    capability: TypstBackendCapability;
    capabilityReason?: TypstUnsupportedReason;
    statusMessage: string;
    documentVersion: number;
    viewport: TypstViewport;
    pages: TypstPageMetric[];
    diagnostics: TypstRenderDiagnostic[];
    blocks: TypstBlockModel[];
    lastError?: string;
}
export interface TypstEditableHit {
    kind: "editable-span";
    anchor: string;
    blockKind: TypstBlockKind;
    span: TypstSourceSpan;
    bounds: TypstLayoutBounds;
}
export interface TypstNoneditableHit {
    kind: "noneditable-preview";
    anchor: string;
    blockKind: TypstBlockKind;
    span: TypstSourceSpan;
    bounds: TypstLayoutBounds;
    reason: TypstUnsupportedReason;
}
export interface TypstOutsideHit {
    kind: "outside-document";
}
export interface TypstHitError {
    kind: "error";
    message: string;
}
export type TypstHitTestResult = TypstEditableHit | TypstNoneditableHit | TypstOutsideHit | TypstHitError;
export interface TypstSurfaceSessionNative {
    setDocument(source: string): string;
    getState(): string;
    setViewport(viewport: TypstViewport): string;
    hitTest(x: number, y: number): string;
    snapshotSvg(): string;
}
export interface TypstSurfaceSessionNativeConstructor {
    new (forceDegraded?: boolean): TypstSurfaceSessionNative;
}
declare module "../bindings" {
    interface NativeBindings {
        TypstSurfaceSessionNative: TypstSurfaceSessionNativeConstructor;
    }
}
export interface TypstSurfaceSessionOptions {
    forceDegraded?: boolean;
}
export interface TypstSurfaceJsonCodec {
    parseState(json: string): TypstSurfaceState;
    parseHit(json: string): TypstHitTestResult;
}
export type TypstSurfaceUpdateCallback = TsFunc<TypstSurfaceState>;
//# sourceMappingURL=types.d.ts.map