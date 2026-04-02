/**
 * Watches QML files for changes and calls a callback on modification.
 * Uses native fs.watch; debounces by 150ms to avoid double-firing.
 */
export declare class QmlWatcher {
    #private;
    watch(id: string, filePath: string, onChange: () => void): void;
    unwatch(id: string): void;
    dispose(): void;
}
//# sourceMappingURL=watcher.d.ts.map