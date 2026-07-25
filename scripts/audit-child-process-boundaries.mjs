import fs from "node:fs";
import path from "node:path";

// Keep this audit deliberately local: child-process code, its focused tests,
// and its contract docs must not grow references to sibling/private trees.
const root = path.resolve(new URL("..", import.meta.url).pathname);
const files = [
  "apps/ignis-server/server/child-process.js",
  "apps/ignis-server/server/child-process.test.mjs",
  "packages/shim/src/node/child_process.js",
  "packages/shim/src/node/child_process.test.js",
  "docs/CHILD_PROCESS.md",
];
const forbidden = [
  /(?:^|[\\/])Chadlands(?:[\\/]|$)/i,
  /(?:^|[\\/])collector(?:[\\/]|$)/i,
  /(?:^|[\\/])nandstorm(?:[\\/]|$)/i,
  /(?:^|[\\/])dotfiles(?:[\\/]|$)/i,
  /(?:^|[\\/])homelab(?:[\\/]|$)/i,
  /scoped_workspace/i,
  /\/home\/ogle/i,
  /(?:^|[\\/])\.(?:ssh|aws|config|git)(?:[\\/]|$)/i,
];

const failures = [];
for (const relative of files) {
  const content = fs.readFileSync(path.join(root, relative), "utf8");
  for (const pattern of forbidden) {
    if (pattern.test(content)) failures.push(`${relative}: ${pattern}`);
  }
}

if (failures.length) {
  console.error("child-process boundary audit failed:\n" + failures.join("\n"));
  process.exit(1);
}
console.log(`child-process boundary audit passed (${files.length} files)`);
