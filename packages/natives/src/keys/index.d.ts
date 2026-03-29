/**
 * Keyboard sequence utilities powered by native bindings.
 */
export type { KeyEventType, ParsedKittyResult } from "./types";
export declare const matchesKittySequence: (data: string, expectedCodepoint: number, expectedModifier: number) => boolean, parseKey: (data: string, kittyProtocolActive: boolean) => string | null, matchesLegacySequence: (data: string, keyName: string) => boolean, parseKittySequence: (data: string) => import("./types").ParsedKittyResult | null, matchesKey: (data: string, keyId: string, kittyProtocolActive: boolean) => boolean;
//# sourceMappingURL=index.d.ts.map