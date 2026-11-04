import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function missingScriptTargets(scripts: Record<string, string>, root = repositoryRoot) {
  const missing: string[] = [];
  for (const [name, command] of Object.entries(scripts)) {
    // Repository files a script runs directly, e.g. `tsx scripts/foo.ts` or `node --import tsx bar.ts`.
    for (const match of command.matchAll(/(?:^|\s)((?:\.\/)?[\w.-]+(?:\/[\w.-]+)*\.(?:[cm]?[jt]s))(?=\s|$)/g)) {
      const target = match[1];
      if (!existsSync(path.join(root, target))) missing.push(`${name} -> ${target}`);
    }
  }
  return missing;
}

test("every npm script that runs a repository file points at a file that exists", () => {
  const manifest = JSON.parse(readFileSync(path.join(repositoryRoot, "package.json"), "utf8")) as {
    scripts: Record<string, string>;
  };

  assert.deepEqual(missingScriptTargets(manifest.scripts), []);
});

test("the script target check catches a runner pointing at a missing file", () => {
  assert.deepEqual(
    missingScriptTargets({
      "ai:evaluate": "tsx evaluation/ai-provider-evaluation.ts",
      seed: "tsx prisma/seed.ts",
      test: "node --import tsx --test tests/*.test.ts"
    }),
    ["ai:evaluate -> evaluation/ai-provider-evaluation.ts"]
  );
});
