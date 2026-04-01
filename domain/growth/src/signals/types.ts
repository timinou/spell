export interface SignalSource {
  id: string;
  name: string;
  url: string;
  scraperConfig: string; // path to scraper YAML
  schedule: string; // cron expression, e.g. '0 6 * * *'
  enabled: boolean;
}

export interface SignalConfig {
  sources: SignalSource[];
}

export type DiffType = "new" | "removed" | "changed";

export interface AdDiff {
  adId: string;
  type: DiffType;
  fields?: { field: string; before: string; after: string }[];
}

export interface DiffResult {
  sourceId: string;
  timestamp: string;
  diffs: AdDiff[];
  summary: { new: number; removed: number; changed: number };
}

export interface DigestEntry {
  id: string;
  sourceId: string;
  timestamp: string;
  summary: string;
  diffCount: number;
  read: boolean;
}
