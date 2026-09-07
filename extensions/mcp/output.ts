import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { truncateHead } from "@earendil-works/pi-coding-agent";

/** Use Pi's output limits, retaining the full result privately for follow-up reads. */
export async function limitMcpOutput(
  text: string,
): Promise<{ text: string; fullOutputPath?: string }> {
  const result = truncateHead(text);
  if (!result.truncated) return { text };
  const directory = await mkdtemp(join(tmpdir(), "pi-mcp-output-"));
  const fullOutputPath = join(directory, "output.txt");
  await writeFile(fullOutputPath, text, { encoding: "utf8", mode: 0o600 });
  return {
    text: `${result.content}\n\n[Output truncated to ${result.outputLines} lines / ${result.outputBytes} bytes. Full output: ${fullOutputPath}]`,
    fullOutputPath,
  };
}
