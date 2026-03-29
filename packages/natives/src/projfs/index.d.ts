/**
 * Windows ProjFS-backed overlay lifecycle bindings.
 */
export type { ProjfsOverlayProbeResult } from "./types";
export declare const projfsOverlayProbe: () => import("./types").ProjfsOverlayProbeResult, projfsOverlayStart: (lowerRoot: string, projectionRoot: string) => void, projfsOverlayStop: (projectionRoot: string) => void;
//# sourceMappingURL=index.d.ts.map