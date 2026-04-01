/**
 * Monaco monarch tokenizer definition for Typst.
 *
 * Register with:
 *   monaco.languages.register({ id: 'typst' });
 *   monaco.languages.setMonarchTokensProvider('typst', typstLanguage);
 */

/** Monarch tokenizer for Typst. Suitable for Monaco 0.34+. */
export const typstLanguage = {
  defaultToken: "",
  tokenPostfix: ".typst",

  keywords: [
    "let", "set", "show", "import", "include",
    "if", "else", "for", "while", "return",
    "in", "not", "and", "or", "none", "auto",
    "true", "false",
  ],

  // Operator characters
  operators: [
    "=", "+", "-", "*", "/", "<", ">", "!", "&", "|", "^",
    "~", "%", ".", ",", ":", ";",
  ],

  tokenizer: {
    root: [
      // Code mode hash-keywords: #let, #set, etc.
      [/#(let|set|show|import|include|if|else|for|while|return)\b/, "keyword"],

      // Headings (lines starting with one or more =)
      [/^(={1,6})([^=].*)$/, ["markup.heading", "markup.heading"]],

      // Block comments
      [/\/\*/, "comment", "@blockComment"],

      // Line comments
      [/\/\/.*$/, "comment"],

      // Math mode: $ ... $
      [/\$\$?/, "string.math", "@mathMode"],

      // Strings
      [/"/, "string", "@string"],

      // Raw blocks: ` ... ` or ```lang ... ```
      [/`{3}/, "string.raw", "@rawBlock"],
      [/`/, "string.raw", "@rawInline"],

      // Functions: identifier(
      [/[a-zA-Z_][a-zA-Z0-9_]*(?=\s*\()/, "entity.name.function"],

      // Keywords when prefixed with # are already caught above;
      // bare keywords inside code blocks
      [
        /[a-zA-Z_][a-zA-Z0-9_]*/,
        {
          cases: {
            "@keywords": "keyword",
            "@default": "identifier",
          },
        },
      ],

      // Numbers
      [/\d+(\.\d+)?(pt|mm|cm|in|em|rem|%)?/, "number"],

      // Color literals
      [/#[0-9a-fA-F]{3,8}\b/, "number.hex"],

      // Hash sigil (function/variable prefix)
      [/#/, "delimiter"],

      // Brackets
      [/[{}[\]()]/, "delimiter.bracket"],

      // Whitespace
      [/\s+/, "white"],
    ],

    blockComment: [
      [/[^/*]+/, "comment"],
      [/\/\*/, "comment", "@push"],
      [/\*\//, "comment", "@pop"],
      [/[/*]/, "comment"],
    ],

    mathMode: [
      [/\$\$?/, "string.math", "@pop"],
      [/[a-zA-Z]+/, "variable.math"],
      [/[+\-*/^_]/, "operator.math"],
      [/[{}]/, "delimiter.math"],
      [/./, "string.math"],
    ],

    string: [
      [/[^"\\]+/, "string"],
      [/\\./, "string.escape"],
      [/"/, "string", "@pop"],
    ],

    rawBlock: [
      [/`{3}/, "string.raw", "@pop"],
      [/./, "string.raw"],
    ],

    rawInline: [
      [/`/, "string.raw", "@pop"],
      [/./, "string.raw"],
    ],
  },
} as const;

/** Language configuration (brackets, comments) for Monaco. */
export const typstLanguageConfig = {
  comments: {
    lineComment: "//",
    blockComment: ["/*", "*/"] as [string, string],
  },
  brackets: [
    ["{", "}"],
    ["[", "]"],
    ["(", ")"],
  ] as Array<[string, string]>,
  autoClosingPairs: [
    { open: "{", close: "}" },
    { open: "[", close: "]" },
    { open: "(", close: ")" },
    { open: '"', close: '"' },
    { open: "$", close: "$" },
    { open: "`", close: "`" },
  ],
  surroundingPairs: [
    { open: "{", close: "}" },
    { open: "[", close: "]" },
    { open: "(", close: ")" },
    { open: '"', close: '"' },
    { open: "$", close: "$" },
    { open: "`", close: "`" },
  ],
};
