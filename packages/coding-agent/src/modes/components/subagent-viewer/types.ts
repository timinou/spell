import type { Container, TUI } from "@oh-my-pi/pi-tui";

export interface SubagentViewerContext {
	chatContainer: Container;
	ui: TUI;
	toolOutputExpanded: boolean;
	cwd: string;
}
