import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerReviewLoopCommand } from "./command.ts";

export default function reviewLoopExtension(pi: ExtensionAPI): void {
  registerReviewLoopCommand(pi);
}
