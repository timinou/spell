export interface AdFilter {
  advertiser?: string;
  keywords?: string;
  dateRange?: { from: string; to: string };
  formats?: string[];
  isActive?: boolean;
}

export interface AdDetail {
  adId: string;
  pageId: string;
  pageName: string;
  creativeBody: string;
  deliveryStartTime: string;
  isActive: boolean;
  adFormat: string;
  spendRange?: string;
  impressionsRange?: string;
  snapshotUrl?: string;
  tags?: string[];
  notes?: string;
  starred?: boolean;
}
