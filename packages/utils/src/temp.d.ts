export declare class TempDir {
    #private;
    private constructor();
    static createSync(prefix?: string): TempDir;
    static create(prefix?: string): Promise<TempDir>;
    path(): string;
    absolute(): string;
    remove(): Promise<void>;
    removeSync(): void;
    toString(): string;
    join(...paths: string[]): string;
    [Symbol.asyncDispose](): Promise<void>;
    [Symbol.dispose](): void;
}
//# sourceMappingURL=temp.d.ts.map