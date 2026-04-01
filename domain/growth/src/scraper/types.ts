import { type Static, Type } from "@sinclair/typebox";

/**
 * A regex transform: match `pattern` against input, return capture `group` (1-indexed, default 1).
 * Returns null when there is no match.
 */
export const TransformRegex = Type.Object({
  type: Type.Literal("regex"),
  pattern: Type.String(),
  group: Type.Optional(Type.Integer({ minimum: 0 })),
});

/**
 * A string-replace transform: replace all occurrences of `find` with `replaceWith`.
 */
export const TransformReplace = Type.Object({
  type: Type.Literal("replace"),
  find: Type.String(),
  replaceWith: Type.String(),
});

/**
 * An existence check transform: returns `true` if the input is non-empty, `false` otherwise.
 */
export const TransformExists = Type.Object({
  type: Type.Literal("exists"),
});

// Forward declaration placeholder — replaced by the real recursive definition below.
// TypeBox does not support self-referential schemas out of the box, so chain embeds
// a shallow reference rather than a full recursive type.
export const TransformDef = Type.Union([
  TransformRegex,
  TransformReplace,
  TransformExists,
  // "chain" is defined separately to avoid circular reference issues in TypeBox.
  // At runtime, chain.transforms contains TransformDef items validated in config-loader.
  Type.Object({
    type: Type.Literal("chain"),
    transforms: Type.Array(
      Type.Union([TransformRegex, TransformReplace, TransformExists]),
    ),
  }),
]);

export type TransformDef = Static<typeof TransformDef>;

// ─── Field extraction ────────────────────────────────────────────────────────

/**
 * Describes how to extract a single named field from a DOM element.
 * `attribute` defaults to `textContent` when omitted.
 */
export const FieldExtractor = Type.Object({
  name: Type.String(),
  selector: Type.String(),
  attribute: Type.Optional(Type.String()),
  required: Type.Optional(Type.Boolean()),
  transforms: Type.Optional(Type.Array(TransformDef)),
});

export type FieldExtractor = Static<typeof FieldExtractor>;

// ─── Setup actions ───────────────────────────────────────────────────────────

/**
 * A browser automation action executed before scraping begins.
 * - `navigate`: go to `url`
 * - `wait`: wait for `selector`
 * - `click`: click `selector`
 * - `type`: type `value` into `selector`
 */
export const SetupAction = Type.Object({
  type: Type.Union([
    Type.Literal("navigate"),
    Type.Literal("wait"),
    Type.Literal("click"),
    Type.Literal("type"),
  ]),
  selector: Type.Optional(Type.String()),
  value: Type.Optional(Type.String()),
  url: Type.Optional(Type.String()),
});

export type SetupAction = Static<typeof SetupAction>;

// ─── Pagination ──────────────────────────────────────────────────────────────

export const PaginationConfig = Type.Object({
  type: Type.Union([
    Type.Literal("infinite_scroll"),
    Type.Literal("cursor"),
    Type.Literal("next_button"),
  ]),
  selector: Type.Optional(Type.String()),
  maxItems: Type.Optional(Type.Integer({ minimum: 1 })),
  timeout: Type.Optional(Type.Integer({ minimum: 0 })),
});

export type PaginationConfig = Static<typeof PaginationConfig>;

// ─── Container (what to scrape from a page) ──────────────────────────────────

/**
 * A detail panel is opened by clicking `trigger`, waited for with `wait`,
 * has its own `fields` extracted, then optionally closed with `close`.
 */
export const DetailConfig = Type.Object({
  trigger: Type.String(),
  wait: Type.String(),
  fields: Type.Array(FieldExtractor),
  close: Type.Optional(Type.String()),
});

export type DetailConfig = Static<typeof DetailConfig>;

export const ContainerConfig = Type.Object({
  selector: Type.String(),
  fields: Type.Array(FieldExtractor),
  details: Type.Optional(DetailConfig),
});

export type ContainerConfig = Static<typeof ContainerConfig>;

// ─── Rate limiting ───────────────────────────────────────────────────────────

export const RateLimitConfig = Type.Object({
  requestsPerMinute: Type.Number({ exclusiveMinimum: 0 }),
  backoffMultiplier: Type.Optional(Type.Number({ exclusiveMinimum: 1 })),
  maxBackoffMs: Type.Optional(Type.Integer({ minimum: 0 })),
});

export type RateLimitConfig = Static<typeof RateLimitConfig>;

// ─── Error handling ──────────────────────────────────────────────────────────

export const ErrorIndicator = Type.Object({
  selector: Type.String(),
  /** Action to take when the indicator is detected, e.g. "retry" or "abort". */
  action: Type.String(),
});

export type ErrorIndicator = Static<typeof ErrorIndicator>;

export const ErrorConfig = Type.Object({
  retries: Type.Optional(Type.Integer({ minimum: 0 })),
  screenshotOnError: Type.Optional(Type.Boolean()),
  indicators: Type.Optional(Type.Array(ErrorIndicator)),
});

export type ErrorConfig = Static<typeof ErrorConfig>;

// ─── Schema manifest ─────────────────────────────────────────────────────────

/**
 * A single column in a persisted entity table.
 * `fk` defines a foreign-key reference (not enforced by SQLite unless FK pragma is on).
 */
export const ColumnDef = Type.Object({
  name: Type.String(),
  type: Type.Union([
    Type.Literal("TEXT"),
    Type.Literal("INTEGER"),
    Type.Literal("REAL"),
    Type.Literal("BLOB"),
  ]),
  primary: Type.Optional(Type.Boolean()),
  fk: Type.Optional(
    Type.Object({
      table: Type.String(),
      column: Type.String(),
    }),
  ),
});

export type ColumnDef = Static<typeof ColumnDef>;

export const EntitySchema = Type.Object({
  name: Type.String(),
  tableName: Type.String(),
  columns: Type.Array(ColumnDef),
  /** Each inner array is a composite index column list. */
  indexes: Type.Optional(Type.Array(Type.Array(Type.String()))),
});

export type EntitySchema = Static<typeof EntitySchema>;

export const SchemaManifest = Type.Object({
  entities: Type.Array(EntitySchema),
});

export type SchemaManifest = Static<typeof SchemaManifest>;

// ─── Top-level scraper config ────────────────────────────────────────────────

export const ScraperConfig = Type.Object({
  name: Type.String(),
  url: Type.String({ format: "uri" }),
  setupActions: Type.Optional(Type.Array(SetupAction)),
  containers: Type.Array(ContainerConfig),
  pagination: Type.Optional(PaginationConfig),
  rateLimit: Type.Optional(RateLimitConfig),
  errorHandling: Type.Optional(ErrorConfig),
  schemaManifest: SchemaManifest,
});

export type ScraperConfig = Static<typeof ScraperConfig>;
