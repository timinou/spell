export interface SpellServerConfig {
	http: {
		port: number;
		auth: {
			username: string;
			password: string;
		};
		webhookSecret?: string;
		goalTokens?: Record<string, string>;
	};
}

export interface ChannelsConfig {
	telegram?: {
		botToken: string;
		owners: number[];
	};
}
