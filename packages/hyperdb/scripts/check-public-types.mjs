// Fails the build when a package that must stay internal leaks into the
// published types. Walks the .d.ts import graph from every `exports` entry.
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const INTERNAL_ONLY = ["neverthrow"];

const packageDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8"));

const entries = Object.values(pkg.exports)
  .map((entry) => entry.types)
  .filter(Boolean)
  .map((path) => resolve(packageDir, path));

const specifierPattern =
  /(?:from\s+|import\s*\(\s*|import\s+)["']([^"']+)["']/g;

const resolveDeclaration = (fromFile, specifier) => {
  const base = resolve(dirname(fromFile), specifier.replace(/\.(m?js)$/, ""));
  for (const candidate of [`${base}.d.ts`, join(base, "index.d.ts")]) {
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
};

const leaks = [];
const seen = new Set();
const queue = [...entries];

for (const entry of entries) {
  if (!existsSync(entry)) {
    console.error(`Missing declaration entry: ${entry}. Run the build first.`);
    process.exit(1);
  }
}

while (queue.length > 0) {
  const file = queue.pop();
  if (seen.has(file)) continue;
  seen.add(file);

  const source = readFileSync(file, "utf8");
  for (const [, specifier] of source.matchAll(specifierPattern)) {
    if (specifier.startsWith(".")) {
      const next = resolveDeclaration(file, specifier);
      if (next) queue.push(next);
      continue;
    }
    const packageName = specifier.startsWith("@")
      ? specifier.split("/").slice(0, 2).join("/")
      : specifier.split("/")[0];
    if (INTERNAL_ONLY.includes(packageName)) {
      leaks.push(`${file.slice(packageDir.length + 1)} imports "${specifier}"`);
    }
  }
}

if (leaks.length > 0) {
  console.error("Internal-only packages leaked into public types:");
  for (const leak of leaks) console.error(`  ${leak}`);
  process.exit(1);
}

console.log(`Public types are clean (${seen.size} declaration files checked).`);
