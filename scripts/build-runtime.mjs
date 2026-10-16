import { build } from "esbuild";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const result = await build({
  absWorkingDir: root,
  entryPoints: ["src/cli.ts"],
  outfile: "dist/runtime.mjs",
  bundle: true,
  platform: "node",
  // jsonc-parser's UMD entry hides relative requires inside a factory function.
  // Its ESM entry lets esbuild include those modules in the standalone file.
  mainFields: ["module", "main"],
  target: "node22",
  format: "esm",
  metafile: true,
  legalComments: "inline",
  // Bundled CommonJS dependencies still use require for Node built-ins.
  banner: { js: 'import { createRequire as runtimeCreateRequire } from "node:module"; const require = runtimeCreateRequire(import.meta.url);' },
});

// Carry the bundled dependencies' license/notice files with the standalone runtime.
const packages = new Set();
for (const input of Object.keys(result.metafile.inputs)) {
  const start = input.lastIndexOf("node_modules/");
  if (start === -1) continue;
  const parts = input.slice(start + "node_modules/".length).split("/");
  const name = parts[0].startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
  packages.add(resolve(root, input.slice(0, start), "node_modules", name));
}
const notices = [await readFile(join(root, "LICENSE"), "utf8")];
for (const directory of [...packages].sort()) {
  const pkg = JSON.parse(await readFile(join(directory, "package.json"), "utf8"));
  notices.push(`${pkg.name}@${pkg.version} (${pkg.license ?? "see license text"})`);
  for (const file of (await readdir(directory)).sort()) {
    if (/^(licen[sc]e|copying|notice)(\.|$)/i.test(file)) {
      notices.push(await readFile(join(directory, file), "utf8"));
    }
  }
}
await writeFile(join(root, "dist", "runtime.LICENSES.txt"), notices.join("\n\n--------------------\n\n") + "\n");
