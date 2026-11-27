import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, extname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import ts from "typescript";

const source = fileURLToPath(new URL("../src/", import.meta.url));
const allowedFeatureImports = new Set([
  "account -> auth-entry/index.ts",
  "tenants -> billing/index.ts",
]);

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? sourceFiles(path) : [path];
  });
}

function dependencies(path: string, content: string): string[] {
  const scripts = extname(path) === ".vue"
    ? [...content.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)].map(match => match[1])
    : extname(path) === ".css" ? [] : [content];
  const imports = scripts.flatMap(script =>
    ts.preProcessFile(script, true, true).importedFiles.map(file => file.fileName));
  const blocks = [...content.matchAll(/<(?:script|style)\b[^>]*\bsrc=["']([^"']+)["']/g)];
  const styles = [...content.matchAll(/@import\s+(?:url\(\s*)?["']([^"']+)["']/g)];
  return [...imports, ...blocks.map(match => match[1]), ...styles.map(match => match[1])];
}

test("web uses feature directories with one-way dependencies", () => {
  for (const directory of ["components", "lib", "styles"]) {
    assert.equal(existsSync(join(source, directory)), false, `Legacy directory src/${directory}`);
  }
  const violations: string[] = [];
  for (const file of sourceFiles(source)) {
    if (![".ts", ".js", ".vue", ".css"].includes(extname(file))) continue;
    const from = relative(source, file).split(sep);
    for (const specifier of dependencies(file, readFileSync(file, "utf8"))) {
      if (!specifier.startsWith(".")) continue;
      const to = relative(source, resolve(dirname(file), specifier.split("?")[0])).split(sep);
      if (from[0] === "shared" && ["features", "app", "App.vue", "main.ts"].includes(to[0])) {
        violations.push(`${from.join("/")} -> ${to.join("/")}`);
      }
      if (from[0] === "features" &&
        (["app", "App.vue", "main.ts"].includes(to[0]) ||
          (to[0] === "features" && from[1] !== to[1] &&
            !allowedFeatureImports.has(`${from[1]} -> ${to.slice(1).join("/")}`)))) {
        violations.push(`${from.join("/")} -> ${to.join("/")}`);
      }
    }
  }
  assert.deepEqual(violations, []);
});
