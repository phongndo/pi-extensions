import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerReviewLoopCommand, registerReviewSettingsCommand } from "./loop-command.ts";
import { registerReviewCommand } from "./review-command.ts";

export default function reviewExtension(pi: ExtensionAPI): void {
  registerReviewCommand(pi);
  registerReviewSettingsCommand(pi);
  registerReviewLoopCommand(pi);
}
