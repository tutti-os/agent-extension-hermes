import { chmod, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const output = path.join(packageRoot, "dist", "cli.cjs");

await mkdir(path.dirname(output), { recursive: true });
await build({
  entryPoints: [path.join(packageRoot, "src", "cli.mjs")],
  outfile: output,
  bundle: true,
  format: "cjs",
  platform: "node",
  target: "node22.19",
  legalComments: "inline",
  logLevel: "silent"
});
await chmod(output, 0o755);
