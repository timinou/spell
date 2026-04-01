/** Panel definition: a QML component that can be mounted into a workspace slot. */
export interface PanelDef {
  id: string;
  name: string;
  /** Absolute or skill-relative path to the .qml file. */
  qmlPath: string;
  icon?: string;
  /** Tools armed for bridge invocations from this panel. */
  armedTools?: string[];
}

/** Describes where a panel is placed within a workspace layout. */
export interface WorkspacePanelSlot {
  panelId: string;
  position: "main" | "secondary" | "overlay";
  /** Flex weight for proportional sizing (default: 1). */
  flex?: number;
}

/** A named layout of panels, optionally tied to a default agent mode. */
export interface WorkspaceDef {
  id: string;
  name: string;
  icon: string;
  panels: WorkspacePanelSlot[];
  /** Mode activated automatically when this workspace is selected. */
  defaultMode?: string;
  restrictions?: { readOnly?: boolean };
}

/** Tool inclusion/exclusion for a domain. Empty means no filtering (all tools allowed). */
export interface DomainToolConfig {
  /** If set, only these tool IDs are visible in this domain. */
  include?: string[];
  /** Tool IDs hidden from this domain regardless of include. */
  exclude?: string[];
}

/**
 * Manifest that fully describes a Spell domain — its identity, toolset,
 * workspace layout, and integration points.
 *
 * Domains live under `domain/<name>/manifest.ts` and are loaded dynamically
 * by `packages/coding-agent/src/domain/loader.ts`.
 */
export interface SpellDomain {
  name: string;
  description: string;
  /** Path to a markdown file whose content is injected into the system prompt. */
  systemPromptPath?: string;
  /** Additional context files always included in the agent context. */
  contextFiles?: string[];
  tools: DomainToolConfig;
  panels: PanelDef[];
  workspaces: WorkspaceDef[];
  /** Preferred UI surface when this domain starts interactively. */
  interactiveSurface?: "tui" | "qml";
  /** Custom QML shell used when launching this domain in canvas mode. */
  shellQmlPath?: string;
  /** Directory scanned for .md mode config files (relative to domain root). */
  modesDir?: string;
  /** Loop sub-domains this domain may spin up. */
  loopDomains?: string[];
  /** Artifact type tags produced/consumed by this domain. */
  artifactTypes?: string[];
}
