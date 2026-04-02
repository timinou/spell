import type { AgentStatus } from "./types";
/** Platform-neutral color entry for a given agent status. Hex color values. */
export interface StatusColorEntry {
    /** Background color as hex (e.g. "#a6e3a1") */
    bg: string;
    /** Foreground color as hex (e.g. "#1e1e1e") */
    fg: string;
    /** Human-readable status label */
    label: string;
}
/**
 * Catppuccin-inspired hex color palette for each agent status.
 * Platform integrations convert to their native format (ANSI, QML, CSS, etc.).
 */
export declare const STATUS_COLOR_PALETTE: Record<AgentStatus, StatusColorEntry>;
//# sourceMappingURL=colors.d.ts.map