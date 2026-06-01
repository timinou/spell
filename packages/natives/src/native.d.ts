import type { NativeBindings } from "./bindings";
import "./appearance/types";
import "./ast/types";
import "./clipboard/types";
import "./code-graph/types";
import "./code-buffer/types";
import "./org-buffer/types";
import "./knowledge/types";
import "./glob/types";
import "./grep/types";
import "./highlight/types";
import "./html/types";
import "./image/types";
import "./keys/types";
import "./ps/types";
import "./projfs/types";
import "./pty/types";
import "./shell/types";
import "./text/types";
import "./work/types";
import "./typst-surface/types";
import "./code-path/types";
export type { NativeBindings, TsFunc } from "./bindings";
export declare const native: NativeBindings;
export interface NativeStalenessResult {
    stale: boolean;
    newestSourceFile: string;
    binaryPath: string;
    newestSourceMtimeMs: number;
    binaryMtimeMs: number;
}
export declare function checkStaleness(binaryPath: string, cratesDir: string): NativeStalenessResult | null;
export declare function checkNativeStaleness(cratesDir: string): NativeStalenessResult | null;
//# sourceMappingURL=native.d.ts.map