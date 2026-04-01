export interface ClientConfig {
  id: string;
  name: string;
  description: string;
  keywords: string[];
  competitors: string[];
  brandColor: string;
  logo?: string;
}

export interface ClientSummary {
  client: ClientConfig;
  activeCampaigns: number;
  recentDeliverables: number;
  lastActivity: string;
}
