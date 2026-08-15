import type { ReactNode } from "react";
import type { Snippet } from "../types";

type CodeLanguage = "bash" | "json" | "python" | "typescript" | "javascript" | "text";
const syntaxColor: Record<string, string> = {
  comment: "text-emerald-300/70",
  string: "text-amber-300",
  keyword: "text-fuchsia-300",
  constant: "text-sky-300",
  number: "text-emerald-300",
  operator: "text-zinc-300",
};

export function copy(value: string): Promise<void> {
  return navigator.clipboard.writeText(value);
}

const codeKeywords: Record<Exclude<CodeLanguage, "text">, Set<string>> = {
  typescript: new Set(
    "as async await break case catch class const continue debugger default delete do else export extends finally for from function get if implements import in instanceof interface let new null of package private protected public return satisfies set static super switch throw try type typeof undefined var void while with yield".split(
      " ",
    ),
  ),
  javascript: new Set(
    "as async await break case catch class const continue debugger default delete do else export extends finally for from function get if import in instanceof let new null of return set static super switch throw try typeof undefined var void while with yield".split(
      " ",
    ),
  ),
  python: new Set(
    "and as assert async await break case class continue def del elif else except finally for from global if import in is lambda match nonlocal not or pass raise return try while with yield".split(
      " ",
    ),
  ),
  bash: new Set(
    "case do done elif else esac fi for function if in select then time until while".split(" "),
  ),
  json: new Set(),
};

const codeConstants = new Set(["false", "None", "null", "true", "True", "False", "undefined"]);

export function snippetLanguage(snippet: Snippet): CodeLanguage {
  if (snippet.id === "litellm") return "python";
  if (snippet.id === "curl" || snippet.id === "cli" || snippet.id === "stream") return "bash";
  if (snippet.id === "json") return "json";
  if (snippet.id === "node") return "javascript";
  if (["agent-sdk", "vercel", "tanstack", "openai"].includes(snippet.id)) return "typescript";
  return "text";
}

export function highlightCode(code: string, language: CodeLanguage): ReactNode[] {
  const tokens: ReactNode[] = [];
  const keywords = codeKeywords[language === "text" ? "javascript" : language];
  let index = 0;
  let tokenIndex = 0;
  const push = (value: string, kind?: string) => {
    tokens.push(
      <span key={`${tokenIndex++}`} className={kind ? syntaxColor[kind] : undefined}>
        {value}
      </span>,
    );
  };
  while (index < code.length) {
    const rest = code.slice(index);
    const comment =
      language === "python" || language === "bash" ? rest.startsWith("#") : rest.startsWith("//");
    if (comment) {
      const end = code.indexOf("\n", index);
      const value = code.slice(index, end === -1 ? code.length : end);
      push(value, "comment");
      index += value.length;
      continue;
    }
    if ((language === "typescript" || language === "javascript") && rest.startsWith("/*")) {
      const end = code.indexOf("*/", index + 2);
      const value = code.slice(index, end === -1 ? code.length : end + 2);
      push(value, "comment");
      index += value.length;
      continue;
    }
    const quote = rest[0];
    if (quote === '"' || quote === "'" || (quote === "`" && language !== "bash")) {
      let end = index + 1;
      while (end < code.length) {
        if (code[end] === "\\") {
          end += 2;
          continue;
        }
        if (code[end] === quote) {
          end += 1;
          break;
        }
        end += 1;
      }
      push(code.slice(index, end), "string");
      index = end;
      continue;
    }
    const number = rest.match(/^(?:0x[\da-f]+|\d+(?:\.\d+)?)/i)?.[0];
    if (number) {
      push(number, "number");
      index += number.length;
      continue;
    }
    const identifier = rest.match(/^[A-Za-z_$][\w$]*/)?.[0];
    if (identifier) {
      const kind = codeConstants.has(identifier)
        ? "constant"
        : keywords.has(identifier)
          ? "keyword"
          : undefined;
      push(identifier, kind);
      index += identifier.length;
      continue;
    }
    const operator = rest.match(
      /^(?:===|!==|=>|==|!=|<=|>=|\?\?|&&|\|\||\+\+|--|[+\-*/%=<>!&|?])/i,
    )?.[0];
    if (operator) {
      push(operator, "operator");
      index += operator.length;
      continue;
    }
    push(code[index]!);
    index += 1;
  }
  return tokens;
}
