/**
 * Types for native find API.
 */
export var FileType;
(function (FileType) {
    /** A regular file. */
    FileType[FileType["File"] = 1] = "File";
    /** A directory. */
    FileType[FileType["Dir"] = 2] = "Dir";
    /** A symlink. */
    FileType[FileType["Symlink"] = 3] = "Symlink";
})(FileType || (FileType = {}));
//# sourceMappingURL=types.js.map