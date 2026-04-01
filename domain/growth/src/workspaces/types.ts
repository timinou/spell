export interface WorkspacePanelSlot {
  panelId: string;
  position: 'main' | 'secondary' | 'overlay';
  flex?: number;
}

export interface WorkspaceLayout {
  id: string;
  name: string;
  icon: string;
  panels: WorkspacePanelSlot[];
  defaultMode?: string;
}
