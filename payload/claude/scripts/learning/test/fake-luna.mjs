import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export function fakeLuna(role, briefPath, outPath) {
  const dir = process.env.FAKE_LUNA_DIR;
  fs.appendFileSync(path.join(dir, "calls.log"), `${role}\t${briefPath}\n`);
  const json = path.join(dir, `${role}.json`);
  if (fs.existsSync(path.join(dir, `${role}.fail`)) || !fs.existsSync(json)) {
    fs.writeFileSync(outPath + ".status", "state=failed\nrc=1\nerror=fake\n");
    return { status: 1, stdout: "", stderr: "" };
  }
  fs.writeFileSync(outPath, "Analysis.\n\n```json\n" + fs.readFileSync(json, "utf8") + "\n```\n");
  fs.writeFileSync(outPath + ".status", "state=done\nrc=0\n");
  return { status: 0, stdout: "", stderr: "" };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = fakeLuna(...process.argv.slice(2)).status;
}
