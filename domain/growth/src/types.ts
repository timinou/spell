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
 * Declarative knowledge-lane configuration for a domain.
 *
 * `embeddings:false` skips the fastembed (bge-m3) model load in the
 * knowledge worker; org/memory recall self-degrades to BM25 + graph (no
 * vector lane). Used by autonomous/container profiles where the embedding
 * model's RAM + download cost is unwanted. Surfaced to the worker via the
 * `PI_KNOWLEDGE_WORKER_EMBEDDINGS` env var at activation.
 */
export interface DomainKnowledgeConfig {
  /** When false, skip embeddings; recall is lexical (BM25) + graph only. */
  embeddings?: boolean;
}

/**
 * Declarative environment contract for a domain.
 *
 * `require` names env vars that MUST be present at activation (fail-loud if
 * absent) — e.g. a benchmark harness's injected model. `set` forces env vars
 * for the session (e.g. `PI_KNOWLEDGE_WORKER=inprocess`).
 */
export interface DomainEnvConfig {
  /** Env vars that must be present at activation; missing → startup error. */
  require?: string[];
  /** Env vars forced for the session (name → value). */
  set?: Record<string, string>;
}

/**
 * Manifest that fully describes a Spell domain — its identity, toolset,
 * workspace layout, and integration points.
 *
 * Two constructors build this one shape:
 *  - TS manifest at `domain/<name>/manifest.ts` — behavioral domains that
 *    contribute executable surface (panels, workspaces, custom tooling).
 *  - inline KDL `domain "x" { … }` block — declarative domains whose entire
 *    definition is data (prompt/tools/surface/env/model). Parsed by
 *    `config/kdl-domains.ts`. A domain is KDL-definable iff it contributes no
 *    executable behavior.
 *
 * Loaded dynamically by `packages/coding-agent/src/domain/loader.ts`.
 */
export interface SpellDomain {
  name: string;
  description: string;
  /** Path to a markdown file whose content is injected into the system prompt. */
  systemPromptPath?: string;
  /**
   * Inline system-prompt text (KDL domains). Mutually exclusive with
   * `systemPromptPath`; when both are set, `systemPrompt` wins. Lets a
   * declarative domain carry its prompt in the KDL block with no sidecar file.
   */
  systemPrompt?: string;
  /** Additional context files always included in the agent context. */
  contextFiles?: string[];
  tools: DomainToolConfig;
  panels: PanelDef[];
  workspaces: WorkspaceDef[];
  /**
   * Preferred UI surface when this domain starts interactively.
   * `"none"` marks a headless/autonomous domain: no human is present, so the
   * startup route falls through to print/rpc and interactive-only tools
   * (ask/canvas/send_file/approvals/checkpoint) are gated off.
   */
  interactiveSurface?: "tui" | "qml" | "none";
  /** Custom QML shell used when launching this domain in canvas mode. */
  shellQmlPath?: string;
  /** Directory scanned for .md mode config files (relative to domain root). */
  modesDir?: string;
  /** Loop sub-domains this domain may spin up. */
  loopDomains?: string[];
  /** Artifact type tags produced/consumed by this domain. */
  artifactTypes?: string[];
  /** Knowledge-lane config (declarative domains): embeddings on/off. */
  knowledge?: DomainKnowledgeConfig;
  /** Environment contract (declarative domains): required + forced env vars. */
  env?: DomainEnvConfig;
  /**
   * Model role overrides applied when this domain activates (e.g. pin
   * `default`/`task` to a harness-injected model). Merged into settings via
   * `overrideModelRoles`. Values may contain `$VAR` refs resolved against
   * the environment at activation.
   */
  modelRoles?: Record<string, string>;
}
