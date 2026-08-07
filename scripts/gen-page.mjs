/**
 * 由 src/webui/index.html 生成 src/webui/page.ts（内嵌页面，零静态文件依赖）。
 *
 * 用法：node scripts/gen-page.mjs
 * 原理：把 HTML 全文包进 String.raw 模板字符串导出为 PAGE_HTML。
 * 约束：index.html 内不得出现反引号 ` 与 ${（会破坏外层模板字符串）。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const htmlPath = path.join(root, "src/webui/index.html");
const outPath = path.join(root, "src/webui/page.ts");

const html = fs.readFileSync(htmlPath, "utf8");
if (html.includes("`") || html.includes("${")) {
  console.error("index.html 含有反引号或 ${，无法安全内嵌进模板字符串");
  process.exit(1);
}

const header = `/**
 * WebUI 前端页面（内嵌于服务端，零静态文件依赖）。
 *
 * 页面源码：src/webui/index.html。本文件由构建时生成，
 * 修改页面请直接编辑 index.html，然后用
 * \`node scripts/gen-page.mjs\`（或本文件顶部的生成逻辑）重新生成。
 */

export const PAGE_HTML = String.raw\``;

fs.writeFileSync(outPath, header + html + "`;\n");
console.log("generated", path.relative(root, outPath), `(${html.length} chars)`);
