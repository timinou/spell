export type EmbeddedAddonVariant = "modern" | "baseline" | "default";
export interface EmbeddedAddonFile {
    variant: EmbeddedAddonVariant;
    filename: string;
    filePath: string;
}
export interface EmbeddedAddon {
    platformTag: string;
    version: string;
    files: EmbeddedAddonFile[];
}
export declare const embeddedAddon: EmbeddedAddon | null;
//# sourceMappingURL=embedded-addon.d.ts.map