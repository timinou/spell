import type { TelegramChannelConfig } from "../config/types";

/**
 * TelegramBridgeConfig is now an alias for TelegramChannelConfig.
 * All telegram bot code references this type; the actual config
 * comes from channels.kdl parsed by the KDL config system.
 */
export type TelegramBridgeConfig = TelegramChannelConfig;

export type { TelegramChannelConfig, TelegramUserConfig } from "../config/types";
export type { UserConfig } from "../rpc/bridge-types";
