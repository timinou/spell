declare class DevProfileImpl {
    #private;
    static readonly enabled: boolean;
    constructor();
    get path(): string;
    recordFrame(info: {
        frameMs: number;
        dirtyCount?: number;
        linesChanged?: number;
    }): void;
    close(): void;
}
export declare const devProfile: DevProfileImpl;
export declare const DevProfile: typeof DevProfileImpl;
export {};
//# sourceMappingURL=dev-profile.d.ts.map