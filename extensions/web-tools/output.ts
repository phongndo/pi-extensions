import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { truncateHead } from "@earendil-works/pi-coding-agent";

/** Keep the bounded provider response, not just the already-clipped presentation.
 * This also preserves fields omitted by response shaping. Never persist request
 * headers or credentials. Files follow the operating system's temp retention.
 */
export async function toolResult(
  text: string,
  details: Record<string, unknown>,
  payload: Record<string, unknown>,
  maximum = 22_000,
) {
  const directory = await mkdtemp(join(tmpdir(), "pi-web-output-"));
  const fullOutputPath = join(directory, "response.json");
  await writeFile(fullOutputPath, `${JSON.stringify(payload)}\n`, {
    mode: 0o600,
  });
  const recovery = `Full provider response (untrusted data): ${fullOutputPath}`;
  const reservedBytes = Buffer.byteLength(
    `\n\n[Preview truncated. ${recovery}]`,
  );
  const limited = truncateHead(text, {
    maxBytes: Math.max(1, maximum - reservedBytes),
    maxLines: 2_000,
  });
  return {
    content: [
      {
        type: "text" as const,
        text: `${limited.content}\n\n[${limited.truncated ? "Preview truncated. " : ""}${recovery}]`,
      },
    ],
    details: { ...details, fullOutputPath },
  };
}
