import type { SpellDomain } from './src/types';

export const growthDomain: SpellDomain = {
  name: 'growth',
  description: 'Growth marketing and competitive intelligence workspace',
  systemPromptPath: 'domain/growth/prompts/system.md',
  contextFiles: [
    'domain/growth/prompts/context.md',
  ],
  tools: {
    exclude: ['lsp', 'ast_grep', 'ast_edit', 'emacs_code'],
  },
  panels: [
    { id: 'dashboard', name: 'Dashboard', qmlPath: 'domain/growth/src/qml/panels/GrowthDashboard.qml', icon: 'chart' },
    { id: 'intel', name: 'Intelligence', qmlPath: 'domain/growth/src/qml/panels/IntelPanel.qml', icon: 'search', armedTools: ['ads_query'] },
    { id: 'editor', name: 'Report Editor', qmlPath: 'domain/growth/src/qml/panels/EditorPanel.qml', icon: 'edit' },
    { id: 'portfolio', name: 'Portfolio', qmlPath: 'domain/growth/src/qml/panels/PortfolioPanel.qml', icon: 'briefcase' },
    { id: 'planner', name: 'Campaign Planner', qmlPath: 'domain/growth/src/qml/panels/KanbanBoard.qml', icon: 'kanban', armedTools: ['create_campaign', 'move_campaign', 'update_campaign'] },
  ],
  workspaces: [
    { id: 'general', name: 'General', icon: 'home', panels: [{ panelId: 'chat', position: 'main' }] },
    { id: 'research', name: 'Research', icon: 'search', panels: [{ panelId: 'intel', position: 'main', flex: 2 }, { panelId: 'chat', position: 'secondary', flex: 1 }], defaultMode: 'intel' },
    { id: 'strategy', name: 'Strategy', icon: 'lightbulb', panels: [{ panelId: 'dashboard', position: 'main', flex: 2 }, { panelId: 'chat', position: 'secondary', flex: 1 }], defaultMode: 'strategy' },
    { id: 'create', name: 'Create', icon: 'edit', panels: [{ panelId: 'editor', position: 'main', flex: 2 }, { panelId: 'chat', position: 'secondary', flex: 1 }], defaultMode: 'pitch' },
    { id: 'review', name: 'Review', icon: 'chart', panels: [{ panelId: 'dashboard', position: 'main' }, { panelId: 'editor', position: 'secondary' }], defaultMode: 'review' },
    { id: 'campaign', name: 'Campaign', icon: 'rocket', panels: [{ panelId: 'planner', position: 'main', flex: 2 }, { panelId: 'chat', position: 'secondary', flex: 1 }], defaultMode: 'campaign' },
  ],
  modesDir: 'domain/growth/modes',
  artifactTypes: ['typst', 'pdf', 'yaml'],
};

export default growthDomain;
