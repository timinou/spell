export interface CopyPattern {
  theme: string;
  frequency: number;
  examples: string[];
}

export interface VisualPattern {
  format: string;
  count: number;
  percentage: number;
}

export interface StrategicPattern {
  signal: string;
  evidence: string[];
  confidence: "high" | "medium" | "low";
}

export interface CreativeAnalysis {
  adSetId: string;
  analyzedAt: string;
  totalAds: number;
  copyPatterns: CopyPattern[];
  visualPatterns: VisualPattern[];
  strategicPatterns: StrategicPattern[];
  recommendations: string[];
}

export interface AnalysisRequest {
  adSetId: string;
  ads: Array<{
    adId: string;
    pageId: string;
    pageName: string;
    creativeBody: string;
    adFormat: string;
    isActive: boolean;
    spendRange?: string;
    deliveryStartTime?: string;
  }>;
}
