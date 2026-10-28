import Prism from "prismjs";
// Order matters: each language extends the ones before it.
import "prismjs/components/prism-c";
import "prismjs/components/prism-cpp";
import "prismjs/components/prism-csharp";
import "prismjs/components/prism-java";
import "prismjs/components/prism-kotlin";
import "prismjs/components/prism-swift";
import "prismjs/components/prism-go";
import "prismjs/components/prism-rust";
import "prismjs/components/prism-python";
import "prismjs/components/prism-ruby";
import "prismjs/components/prism-lua";
import "prismjs/components/prism-sql";
import "prismjs/components/prism-yaml";
import "prismjs/components/prism-json";
import "prismjs/components/prism-toml";
import "prismjs/components/prism-ini";
import "prismjs/components/prism-bash";
import "prismjs/components/prism-docker";
import "prismjs/components/prism-makefile";
import "prismjs/components/prism-hcl";
import "prismjs/components/prism-graphql";
import "prismjs/components/prism-protobuf";
import "prismjs/components/prism-scss";
import "prismjs/components/prism-markdown";
import "prismjs/components/prism-typescript";
import "prismjs/components/prism-jsx";
import "prismjs/components/prism-tsx";

/** A run of text with the token classes that apply to it ("" for plain). */
export interface Run {
  text: string;
  cls: string;
}

export type Lines = Run[][];

const BY_EXT: Record<string, string> = {
  go: "go",
  rs: "rust",
  ts: "typescript",
  mts: "typescript",
  cts: "typescript",
  tsx: "tsx",
  js: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  jsx: "jsx",
  py: "python",
  rb: "ruby",
  lua: "lua",
  sql: "sql",
  yml: "yaml",
  yaml: "yaml",
  json: "json",
  jsonc: "json",
  toml: "toml",
  ini: "ini",
  cfg: "ini",
  sh: "bash",
  bash: "bash",
  zsh: "bash",
  md: "markdown",
  mdx: "markdown",
  html: "markup",
  htm: "markup",
  xml: "markup",
  svg: "markup",
  vue: "markup",
  svelte: "markup",
  css: "css",
  scss: "scss",
  c: "c",
  h: "c",
  cc: "cpp",
  cpp: "cpp",
  hpp: "cpp",
  cs: "csharp",
  java: "java",
  kt: "kotlin",
  kts: "kotlin",
  swift: "swift",
  tf: "hcl",
  hcl: "hcl",
  graphql: "graphql",
  gql: "graphql",
  proto: "protobuf",
  mk: "makefile",
};

const BY_NAME: Record<string, string> = {
  dockerfile: "docker",
  makefile: "makefile",
  "go.mod": "go",
  "cargo.lock": "toml",
};

export function languageFor(path: string): string | null {
  const name = path.split("/").pop()!.toLowerCase();
  if (BY_NAME[name]) return BY_NAME[name];
  if (name.startsWith("dockerfile")) return "docker";
  const ext = name.includes(".") ? name.split(".").pop()! : "";
  const lang = BY_EXT[ext];
  return lang && Prism.languages[lang] ? lang : null;
}

/** Above this, highlighting is skipped: the cost stops being worth it. */
const MAX_HIGHLIGHT_CHARS = 600_000;

/**
 * Tokenizes a whole file and splits the result into lines of runs. Tokens
 * that span lines (block comments, template strings) carry their class onto
 * every line they cover.
 */
export function highlightLines(text: string, lang: string | null): Lines {
  const normalized = text.replace(/\r\n?/g, "\n");
  const lines: Lines = [[]];
  const push = (t: string, cls: string) => {
    const parts = t.split("\n");
    parts.forEach((part, i) => {
      if (i > 0) lines.push([]);
      if (part) lines[lines.length - 1].push({ text: part, cls });
    });
  };
  const grammar = lang ? Prism.languages[lang] : undefined;
  if (!grammar || normalized.length > MAX_HIGHLIGHT_CHARS) {
    push(normalized, "");
  } else {
    const walk = (tokens: (string | Prism.Token)[], classes: string) => {
      for (const t of tokens) {
        if (typeof t === "string") {
          push(t, classes);
        } else {
          const alias = Array.isArray(t.alias) ? t.alias.join(" ") : (t.alias ?? "");
          const cls = `${classes} ${t.type} ${alias}`.trim();
          const content = t.content;
          if (typeof content === "string") push(content, cls);
          else walk(Array.isArray(content) ? content : [content], cls);
        }
      }
    };
    walk(Prism.tokenize(normalized, grammar), "");
  }
  // A trailing newline does not start another line.
  if (normalized.endsWith("\n")) lines.pop();
  return lines;
}

export function plainLine(text: string): Run[] {
  return text ? [{ text, cls: "" }] : [];
}

export function lineText(runs: Run[]): string {
  return runs.map((r) => r.text).join("");
}
