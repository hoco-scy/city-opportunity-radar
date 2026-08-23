import { readdir, readFile } from "node:fs/promises";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const textExtensions = new Set([".html", ".css", ".js", ".mjs", ".json", ".md"]);
const blockedKeyPattern = /["'](?:candidateName|fullName|phone|email|birthDate|homeAddress|schoolName|studentId|idCard|portrait|avatar)["']\s*:/i;
const phonePattern = /(?<!\d)1[3-9]\d{9}(?!\d)/;
const emailPattern = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i;
const errors = [];

async function walk(path, relative = "") {
  for (const entry of await readdir(path, { withFileTypes: true })) {
    if ([".git", "node_modules", ".data", ".wrangler", "dist"].includes(entry.name)) continue;
    const full = join(path, entry.name);
    const rel = join(relative, entry.name);
    if (entry.isDirectory()) await walk(full, rel);
    else if (textExtensions.has(extname(entry.name))) {
      const text = await readFile(full, "utf8");
      if (blockedKeyPattern.test(text)) errors.push(`${rel}: 出现禁止公开的个人资料字段`);
      if (phonePattern.test(text)) errors.push(`${rel}: 出现疑似个人手机号`);
      if (emailPattern.test(text)) errors.push(`${rel}: 出现电子邮箱地址`);
    }
  }
}

await walk(root);
if (errors.length) {
  console.error(errors.map((error) => `- ${error}`).join("\n"));
  process.exit(1);
}
console.log("匿名发布检查通过：未发现常见个人识别字段、手机号或邮箱。");
