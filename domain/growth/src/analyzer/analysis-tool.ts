import { Database } from "bun:sqlite";
import type { AgentTool, AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { getEnvApiKey, streamSimple } from "@oh-my-pi/pi-ai";
import type { Model } from "@oh-my-pi/pi-ai";
import { logger } from "@oh-my-pi/pi-utils";
import { type Static, Type } from "@sinclair/typebox";
import type { AnalysisRequest, CreativeAnalysis } from "./types.ts";
import analysisPromptTemplate from "./analysis-prompt.md" with { type: "text" };

// ─── Input schema ─────────────────────────────────────────────────────────────

const inputSchema = Type.Object({
  adSetId: Type.String({
    description: "Page ID whose ads will be analyzed (maps to page_id in the ads table)",
  }),
  filters: Type.Optional(
    Type.Object({
      isActive: Type.Optional(Type.Boolean({ description: "Include only active or inactive ads" })),
      adFormat: Type.Optional(Type.String({ description: "Filter by ad format (e.g. image, video)" })),
      limit: Type.Optional(
        Type.Integer({ minimum: 1, maximum: 500, description: "Max ads to fetch (default: 100)" }),
      ),
    }),
  ),
});

type AnalysisInput = Static<typeof inputSchema>;

// ─── SQLite row shape ─────────────────────────────────────────────────────────

interface AdRow {
  ad_id: string;
  page_id: string;
  page_name: string | null;
  creative_body: string | null;
  ad_format: string | null;
  // SQLite stores booleans as 0/1 integers
  is_active: number | null;
  spend_range: string | null;
  delivery_start_time: string | null;
}

// ─── Tool options ─────────────────────────────────────────────────────────────

export interface AnalysisToolOptions {
  /** Absolute path to the SQLite database produced by the scraper. */
  dbPath: string;
  /** Model used for the sub-LLM analysis call. */
  model: Model;
}

// ─── Tool implementation ──────────────────────────────────────────────────────

class AnalysisTool implements AgentTool<typeof inputSchema, CreativeAnalysis> {
  name = "analyze_ad_set" as const;
  label = "Analyze Ad Set";
  description =
    "Analyze competitor ad creatives for an advertiser page. " +
    "Fetches ads from the local SQLite database, constructs an analysis prompt, " +
    "and returns copy patterns, visual patterns, strategic signals, and recommendations.";
  parameters = inputSchema;

  readonly #db: Database;
  readonly #model: Model;

  constructor({ dbPath, model }: AnalysisToolOptions) {
    // Open read-only: this tool never mutates scraped data.
    this.#db = new Database(dbPath, { readonly: true });
    this.#db.exec("PRAGMA journal_mode=WAL;");
    this.#model = model;
  }

  async execute(
    _toolCallId: string,
    input: AnalysisInput,
    signal?: AbortSignal,
  ): Promise<AgentToolResult<CreativeAnalysis>> {
    const rows = this.#queryAds(input);

    if (rows.length === 0) {
      return {
        content: [{ type: "text", text: `No ads found for adSetId "${input.adSetId}".` }],
      };
    }

    logger.debug({ adSetId: input.adSetId, count: rows.length }, "analyze_ad_set: fetched ads");

    const request = buildAnalysisRequest(input.adSetId, rows);
    const prompt = buildAnalysisPrompt(request);
    const analysis = await this.#runAnalysis(input.adSetId, prompt, signal);

    return {
      content: [{ type: "text", text: JSON.stringify(analysis, null, 2) }],
      details: analysis,
    };
  }

  dispose(): void {
    this.#db.close();
  }

  // ─── Private helpers ────────────────────────────────────────────────────────

  #queryAds(input: AnalysisInput): AdRow[] {
    const conditions: string[] = ["a.page_id = ?"];
    const values: unknown[] = [input.adSetId];

    if (input.filters?.isActive !== undefined) {
      conditions.push("a.is_active = ?");
      values.push(input.filters.isActive ? 1 : 0);
    }
    if (input.filters?.adFormat !== undefined) {
      conditions.push("a.ad_format = ?");
      values.push(input.filters.adFormat);
    }

    const limit = input.filters?.limit ?? 100;
    const sql = `
      SELECT a.ad_id, a.page_id, p.page_name,
             a.creative_body, a.ad_format, a.is_active,
             a.spend_range, a.delivery_start_time
      FROM ads a
      LEFT JOIN pages p ON a.page_id = p.page_id
      WHERE ${conditions.join(" AND ")}
      ORDER BY a.delivery_start_time DESC
      LIMIT ?
    `;
    values.push(limit);

    return this.#db
      .prepare(sql)
      .all(...(values as Parameters<ReturnType<Database["prepare"]>["all"]>)) as AdRow[];
  }

  async #runAnalysis(
    adSetId: string,
    prompt: string,
    signal?: AbortSignal,
  ): Promise<CreativeAnalysis> {
    const apiKey = getEnvApiKey(this.#model.provider);
    if (!apiKey) {
      throw new Error(`analyze_ad_set: no API key for provider "${this.#model.provider}"`);
    }

    const eventStream = streamSimple(
      this.#model,
      {
        systemPrompt: prompt,
        messages: [
          {
            role: "user",
            content: "Analyze the ads above and return the JSON object as specified.",
            timestamp: Date.now(),
          },
        ],
      },
      { apiKey, signal },
    );

    let text = "";
    for await (const event of eventStream) {
      if (event.type === "text_delta") {
        text += event.delta;
        continue;
      }
      if (event.type === "done" || event.type === "error") break;
    }

    return parseAnalysisResponse(adSetId, text);
  }
}

// ─── Public factory ───────────────────────────────────────────────────────────

/**
 * Create an armed tool definition for ad set analysis.
 *
 * The returned `AgentTool` fetches competitor ads from the local SQLite
 * database, builds a structured analysis prompt, and makes a sub-LLM call
 * to produce a `CreativeAnalysis`.
 */
export function createAnalysisTool(options: AnalysisToolOptions): AgentTool {
  return new AnalysisTool(options);
}

// ─── Prompt builder ───────────────────────────────────────────────────────────

/**
 * Render the analysis prompt template with the given `AnalysisRequest`.
 *
 * Template syntax supported:
 *   - `{{varName}}` — replaced with the corresponding top-level field
 *   - `{{#each ads}}…{{/each}}` — repeated for each ad; inner `{{field}}`
 *     references resolve against the current ad item.
 */
export function buildAnalysisPrompt(request: AnalysisRequest): string {
  const uniquePages = new Set(request.ads.map((ad) => ad.pageId)).size;

  // Build each ad block from the {{#each ads}}…{{/each}} section.
  // IMPORTANT: all replacements use function form (() => value) to prevent
  // JS from interpreting '$1', '$&', etc. in ad copy as replacement specials.
  const eachPattern = /\{\{#each ads\}\}([\s\S]*?)\{\{\/each\}\}/;
  const match = analysisPromptTemplate.match(eachPattern);
  const itemTemplate = match?.[1] ?? "";

  const adsBlock = request.ads
    .map((ad) =>
      itemTemplate
        .replace(/\{\{adId\}\}/g, () => ad.adId)
        .replace(/\{\{pageName\}\}/g, () => ad.pageName)
        .replace(/\{\{adFormat\}\}/g, () => ad.adFormat)
        .replace(/\{\{isActive\}\}/g, () => String(ad.isActive))
        .replace(/\{\{deliveryStartTime\}\}/g, () => ad.deliveryStartTime ?? "unknown")
        .replace(/\{\{spendRange\}\}/g, () => ad.spendRange ?? "unknown")
        .replace(/\{\{creativeBody\}\}/g, () => ad.creativeBody),
    )
    .join("");

  return analysisPromptTemplate
    // Replace the each block with rendered ad sections.
    .replace(eachPattern, () => adsBlock)
    .replace(/\{\{totalAds\}\}/g, () => String(request.ads.length))
    .replace(/\{\{uniquePages\}\}/g, () => String(uniquePages));
}

// ─── Request builder ──────────────────────────────────────────────────────────

/** Convert raw SQLite rows + page_id into an `AnalysisRequest`. */
function buildAnalysisRequest(adSetId: string, rows: AdRow[]): AnalysisRequest {
  return {
    adSetId,
    ads: rows.map((row) => ({
      adId: row.ad_id,
      pageId: row.page_id,
      pageName: row.page_name ?? "Unknown",
      creativeBody: row.creative_body ?? "",
      adFormat: row.ad_format ?? "unknown",
      isActive: row.is_active !== 0 && row.is_active !== null,
      spendRange: row.spend_range ?? undefined,
      deliveryStartTime: row.delivery_start_time ?? undefined,
    })),
  };
}

// ─── Response parser ──────────────────────────────────────────────────────────

/**
 * Parse the LLM's text output into a `CreativeAnalysis`.
 *
 * The LLM is instructed to return JSON. We extract the first JSON object found
 * in the response to tolerate preamble text or markdown fences.
 */
function parseAnalysisResponse(adSetId: string, text: string): CreativeAnalysis {
  // Strip markdown code fence if present (```json … ```)
  const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const jsonText = fenceMatch?.[1]?.trim() ?? text.trim();

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    logger.warn({ adSetId, textLength: text.length }, "analyze_ad_set: failed to parse LLM response as JSON");
    // Return a minimal valid analysis rather than throwing — callers can check
    // that the pattern arrays are empty to detect a degraded result.
    return {
      adSetId,
      analyzedAt: new Date().toISOString(),
      totalAds: 0,
      copyPatterns: [],
      visualPatterns: [],
      strategicPatterns: [],
      recommendations: [],
    };
  }

  return {
    adSetId,
    analyzedAt: new Date().toISOString(),
    totalAds: typeof parsed["totalAds"] === "number" ? parsed["totalAds"] : 0,
    copyPatterns: Array.isArray(parsed["copyPatterns"]) ? parsed["copyPatterns"] : [],
    visualPatterns: Array.isArray(parsed["visualPatterns"]) ? parsed["visualPatterns"] : [],
    strategicPatterns: Array.isArray(parsed["strategicPatterns"]) ? parsed["strategicPatterns"] : [],
    recommendations: Array.isArray(parsed["recommendations"]) ? parsed["recommendations"] : [],
  };
}
