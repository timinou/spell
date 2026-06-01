/**
 * Color manipulation utilities for hex colors.
 *
 * @example
 * ```ts
 * import { hexToHsv, hsvToHex } from "@spell/pi-utils";
 *
 * // Work with HSV directly
 *
 * // Or work with HSV directly
 * const hsv = hexToHsv("#4ade80");
 * hsv.h = (hsv.h + 90) % 360;
 * const newHex = hsvToHex(hsv);
 * ```
 */
export interface HSV {
    /** Hue in degrees (0-360) */
    h: number;
    /** Saturation (0-1) */
    s: number;
    /** Value/brightness (0-1) */
    v: number;
}
export interface RGB {
    /** Red (0-255) */
    r: number;
    /** Green (0-255) */
    g: number;
    /** Blue (0-255) */
    b: number;
}
/**
 * Parse a hex color string to RGB.
 * Supports #RGB, #RRGGBB formats.
 */
export declare function hexToRgb(hex: string): RGB;
/**
 * Convert RGB to hex color string.
 */
export declare function rgbToHex(rgb: RGB): string;
/**
 * Convert RGB to HSV.
 */
export declare function rgbToHsv(rgb: RGB): HSV;
/**
 * Convert HSV to RGB.
 */
export declare function hsvToRgb(hsv: HSV): RGB;
/**
 * Convert hex color to HSV.
 */
export declare function hexToHsv(hex: string): HSV;
/**
 * Convert HSV to hex color.
 */
export declare function hsvToHex(hsv: HSV): string;
/**
 * Shift the hue of a hex color by a given number of degrees.
 */
export declare function shiftHue(hex: string, degrees: number): string;
export interface HSVAdjustment {
    /** Hue shift in degrees (additive) */
    h?: number;
    /** Saturation multiplier */
    s?: number;
    /** Value/brightness multiplier */
    v?: number;
}
/**
 * Adjust HSV components of a hex color.
 *
 * @param hex - Hex color string (#RGB or #RRGGBB)
 * @param adj - Adjustments: h is additive degrees, s and v are multipliers
 * @returns New hex color string
 *
 * @example
 * ```ts
 * // Shift hue +60°, reduce saturation to 71%
 * adjustHsv("#00ff88", { h: 60, s: 0.71 }) // "#4a9eff"
 * ```
 */
export declare function adjustHsv(hex: string, adj: HSVAdjustment): string;
//# sourceMappingURL=color.d.ts.map