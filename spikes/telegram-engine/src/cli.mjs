import { readFile } from "node:fs/promises";
import { parseJsonLines, summarize } from "./summary.mjs";

const inputPath = process.argv[2];
if (!inputPath) {
  console.error("usage: npm run summarize -- <result.jsonl>");
  process.exitCode = 2;
} else {
  try {
    const summary = summarize(parseJsonLines(await readFile(inputPath, "utf8")));
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
    if (Object.values(summary).some((candidate) => !candidate.eligible)) process.exitCode = 1;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 2;
  }
}
