export interface DashboardMetrics {
  newAds: number;
  pendingDeliverables: number;
  activeCampaigns: number;
}

export interface AdSummary {
  adId: string;
  pageName: string;
  creativeBody: string;
  deliveryStartTime: string;
  isActive: boolean;
  adFormat: string;
}

export interface DashboardData {
  metrics: DashboardMetrics;
  recentAds: AdSummary[];
  pipeline: { brief: number; draft: number; review: number; final: number; sent: number };
  deadlines: Array<{ title: string; dueDate: string; state: string }>;
}
