/**
 * Format a duration in milliseconds to a short human-readable string.
 * Examples: "123ms", "1.5s", "30m15s", "2h30m", "3d2h"
 */
export declare function formatDuration(ms: number): string;
/**
 * Format a number with K/M/B suffix for compact display.
 * Uses 1 decimal for small leading digits, rounded otherwise.
 * Examples: "999", "1.5K", "25K", "1.5M", "25M", "1.5B"
 */
export declare function formatNumber(n: number): string;
/**
 * Format a byte count to a human-readable string.
 * Examples: "512B", "1.5KB", "2.3MB", "1.2GB"
 */
export declare function formatBytes(bytes: number): string;
/**
 * Truncate a string to maxLen characters, appending an ellipsis if truncated.
 * For display-width-aware truncation (terminals), use truncateToWidth from @oh-my-pi/pi-tui.
 */
export declare function truncate(str: string, maxLen: number, ellipsis?: string): string;
/**
 * Format count with pluralized label (e.g., "3 files", "1 error").
 */
export declare function formatCount(label: string, count: number): string;
/**
 * Format age from seconds to human-readable string.
 */
export declare function formatAge(ageSeconds: number | null | undefined): string;
/**
 * Pluralize a label based on the count.
 */
export declare function pluralize(label: string, count: number): string;
/**
 * Format a ratio as a percentage.
 */
export declare function formatPercent(ratio: number): string;
//# sourceMappingURL=format.d.ts.map