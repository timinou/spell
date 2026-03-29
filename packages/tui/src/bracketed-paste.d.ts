export type PasteResult = {
    handled: false;
} | {
    handled: true;
    pasteContent?: string;
    remaining: string;
};
/**
 * Handles bracketed paste mode buffering for terminal input components.
 *
 * Bracketed paste mode wraps pasted content between start (\x1b[200~) and
 * end (\x1b[201~) markers, which may arrive split across multiple chunks.
 * This class buffers incoming data and assembles complete paste payloads.
 */
export declare class BracketedPasteHandler {
    #private;
    /**
     * Process incoming terminal data for bracketed paste sequences.
     *
     * @returns `{ handled: false }` if the data contains no paste sequence and
     *          should be processed normally. `{ handled: true }` if the data was
     *          consumed by paste buffering — `pasteContent` is set when a complete
     *          paste has been assembled; omitted when still buffering.
     */
    process(data: string): PasteResult;
}
//# sourceMappingURL=bracketed-paste.d.ts.map