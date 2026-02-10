import assert from "node:assert";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..", "..", "..");
const DOCS_DIR = resolve(ROOT, "docs");
const README_PATH = resolve(ROOT, "README.md");

function walkMarkdownFiles(dir: string): string[] {
  const entries = readdirSync(dir, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    const fullPath = resolve(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...walkMarkdownFiles(fullPath));
      continue;
    }

    if (entry.isFile() && (entry.name.endsWith(".md") || entry.name.endsWith(".mdx"))) {
      files.push(fullPath);
    }
  }

  return files;
}

function extractCodeFences(markdown: string): Array<{ lang: string; code: string; index: number }> {
  const fences: Array<{ lang: string; code: string; index: number }> = [];
  const pattern = /```([a-zA-Z0-9_-]+)\n([\s\S]*?)```/g;

  for (;;) {
    const match = pattern.exec(markdown);
    if (match === null) {
      break;
    }

    const lang = (match[1] ?? "").toLowerCase();
    const code = match[2] ?? "";
    fences.push({ lang, code, index: match.index });
  }

  return fences;
}

function lineForOffset(text: string, offset: number): number {
  return text.slice(0, offset).split("\n").length;
}

function validateSnippet(filePath: string, markdown: string, code: string, index: number): string[] {
  const diagnostics: string[] = [];

  const compilerOptions: ts.CompilerOptions = {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
  };

  const fileName = `${filePath}:${lineForOffset(markdown, index)}`;
  const transpile = ts.transpileModule(code, {
    compilerOptions,
    fileName,
    reportDiagnostics: true,
  });

  for (const diag of transpile.diagnostics ?? []) {
    if (diag.category !== ts.DiagnosticCategory.Error) {
      continue;
    }

    const message = ts.flattenDiagnosticMessageText(diag.messageText, "\n");
    diagnostics.push(`${fileName}: ${message}`);
  }

  return diagnostics;
}

describe("Documentation code fences", () => {
  test("TypeScript and JavaScript snippets are syntactically valid", () => {
    const files = [README_PATH, ...walkMarkdownFiles(DOCS_DIR)];
    const allErrors: string[] = [];

    for (const filePath of files) {
      const markdown = readFileSync(filePath, "utf8");
      const fences = extractCodeFences(markdown);

      for (const fence of fences) {
        if (!["typescript", "ts", "javascript", "js"].includes(fence.lang)) {
          continue;
        }

        const errors = validateSnippet(filePath, markdown, fence.code, fence.index);
        allErrors.push(...errors);
      }
    }

    assert.deepStrictEqual(allErrors, []);
  });
});
