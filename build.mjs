// 构建与自检：把单文件 ESM 源码和 manifest 复制到 dist/，并执行与市场 CI 同类的
// 体积与黑名单检查。无第三方依赖，Node 18+ 直接运行。
import { copyFileSync, mkdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
const dist = join(root, "dist");

const BLACKLIST = [
  { re: /\beval\s*\(/, label: "eval(" },
  { re: /new\s+Function\s*\(/, label: "new Function(" },
  { re: /__TAURI__/, label: "__TAURI__" },
  { re: /\blocalStorage\b/, label: "localStorage" },
  { re: /import\s*\(\s*['"`]https?:\/\//, label: "远程 import(" },
];

const WARN_BYTES = 512 * 1024;
const MAX_BYTES = 2 * 1024 * 1024;

const manifestText = readFileSync(join(root, "manifest.json"), "utf8");
const manifest = JSON.parse(manifestText);
const source = readFileSync(join(root, "src/main.js"), "utf8");

if (!/^\d+\.\d+\.\d+$/.test(manifest.version)) {
  console.error(`manifest.version 不是 semver：${manifest.version}`);
  process.exit(1);
}
if (!source.includes("export default function activate")) {
  console.error("src/main.js 缺少 `export default function activate` 入口");
  process.exit(1);
}

for (const { re, label } of BLACKLIST) {
  if (re.test(source)) {
    console.error(`src/main.js 命中市场黑名单：${label}`);
    process.exit(1);
  }
}

const bytes = Buffer.byteLength(source, "utf8");
if (bytes > MAX_BYTES) {
  console.error(`bundle 超过 2MB 硬上限：${bytes} bytes`);
  process.exit(1);
}
if (bytes > WARN_BYTES) {
  console.warn(`bundle 超过 512KB 警告线：${bytes} bytes`);
}

rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });
copyFileSync(join(root, "src/main.js"), join(dist, "main.js"));
copyFileSync(join(root, "manifest.json"), join(dist, "manifest.json"));

console.log(`built dist/main.js (${(bytes / 1024).toFixed(1)} KB) + dist/manifest.json (v${manifest.version})`);
console.log(`dist/main.js size: ${statSync(join(dist, "main.js")).size} bytes`);
