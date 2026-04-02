/**
 * Catppuccin-inspired hex color palette for each agent status.
 * Platform integrations convert to their native format (ANSI, QML, CSS, etc.).
 */
export const STATUS_COLOR_PALETTE = {
    idle: {
        bg: "#a6e3a1",
        fg: "#1e1e1e",
        label: "Idle",
    },
    running: {
        bg: "#89b4fa",
        fg: "#0a0a0a",
        label: "Running",
    },
    needs_input: {
        bg: "#f9e2af",
        fg: "#141414",
        label: "Needs Input",
    },
    error: {
        bg: "#f38ba8",
        fg: "#0a0a0a",
        label: "Error",
    },
    completed: {
        bg: "#a6e3a1",
        fg: "#1e1e1e",
        label: "Completed",
    },
    pending_approval: {
        bg: "#94e2d5",
        fg: "#0a0a0a",
        label: "Pending Approval",
    },
    user_paused: {
        bg: "#cba6f7",
        fg: "#1e1e1e",
        label: "Paused",
    },
};
//# sourceMappingURL=colors.js.map