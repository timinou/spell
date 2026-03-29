/**
 * Image processing via native bindings.
 */
export { ImageFormat, type PhotonImageConstructor, SamplingFilter } from "./types";
/** PhotonImage class for image manipulation. Use PhotonImage.parse() to create instances. */
export declare const PhotonImage: import("./types").PhotonImageConstructor;
/** Encode image bytes into a SIXEL escape sequence at target pixel size. */
export declare const encodeSixel: (bytes: Uint8Array<ArrayBufferLike>, targetWidthPx: number, targetHeightPx: number) => string;
/** PhotonImage instance type. */
export type PhotonImage = import("./types").PhotonImage;
//# sourceMappingURL=index.d.ts.map