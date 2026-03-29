export interface AutocompleteItem {
    value: string;
    label: string;
    description?: string;
    /** Dim hint text shown inline after cursor when this item is selected */
    hint?: string;
}
export interface SlashCommand {
    name: string;
    description?: string;
    getArgumentCompletions?(argumentPrefix: string): AutocompleteItem[] | null;
    /** Return inline hint text for the current argument state (shown as dim ghost text after cursor) */
    getInlineHint?(argumentText: string): string | null;
}
export interface AutocompleteProvider {
    /** Get autocomplete suggestions for current text/cursor position */
    getSuggestions(lines: string[], cursorLine: number, cursorCol: number): Promise<{
        items: AutocompleteItem[];
        prefix: string;
    } | null>;
    /** Apply the selected item and return new text + cursor position */
    applyCompletion(lines: string[], cursorLine: number, cursorCol: number, item: AutocompleteItem, prefix: string): {
        lines: string[];
        cursorLine: number;
        cursorCol: number;
        onApplied?: () => void;
    };
    /** Get inline hint text to show as dim ghost text after the cursor */
    getInlineHint?(lines: string[], cursorLine: number, cursorCol: number): string | null;
}
export declare class CombinedAutocompleteProvider implements AutocompleteProvider {
    #private;
    constructor(commands?: (SlashCommand | AutocompleteItem)[], basePath?: string);
    getSuggestions(lines: string[], cursorLine: number, cursorCol: number): Promise<{
        items: AutocompleteItem[];
        prefix: string;
    } | null>;
    applyCompletion(lines: string[], cursorLine: number, cursorCol: number, item: AutocompleteItem, prefix: string): {
        lines: string[];
        cursorLine: number;
        cursorCol: number;
    };
    invalidateDirCache(dir?: string): void;
    getForceFileSuggestions(lines: string[], cursorLine: number, cursorCol: number): Promise<{
        items: AutocompleteItem[];
        prefix: string;
    } | null>;
    shouldTriggerFileCompletion(lines: string[], cursorLine: number, cursorCol: number): boolean;
    /** Get inline hint text for slash commands with subcommand hints */
    getInlineHint(lines: string[], cursorLine: number, cursorCol: number): string | null;
}
//# sourceMappingURL=autocomplete.d.ts.map