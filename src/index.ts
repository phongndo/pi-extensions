import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

type RestoreState = {
  model: NonNullable<ExtensionContext["model"]>;
  thinkingLevel: ReturnType<ExtensionAPI["getThinkingLevel"]>;
};

export default function workspaceExtension(pi: ExtensionAPI): void {
  let restoreState: RestoreState | undefined;

  async function restorePreviousModel(ctx: ExtensionContext): Promise<void> {
    const previous = restoreState;
    if (!previous) return;

    restoreState = undefined;

    if (!(await pi.setModel(previous.model))) {
      ctx.ui.notify("Could not restore the previous model", "error");
      return;
    }

    // Model changes can clamp the thinking level, so restore it afterward.
    pi.setThinkingLevel(previous.thinkingLevel);
  }

  pi.registerCommand("commit", {
    description: "Commit changes using DeepSeek V4 Pro at max reasoning",
    handler: async (_args, ctx) => {
      await ctx.waitForIdle();

      if (!ctx.model) {
        ctx.ui.notify("No current model to restore afterward", "error");
        return;
      }

      const commitModel = ctx.modelRegistry.find("opencode-go", "deepseek-v4-pro");
      if (!commitModel) {
        ctx.ui.notify("opencode-go/deepseek-v4-pro is unavailable", "error");
        return;
      }

      restoreState = {
        model: ctx.model,
        thinkingLevel: pi.getThinkingLevel(),
      };

      if (!(await pi.setModel(commitModel))) {
        restoreState = undefined;
        ctx.ui.notify("OpenCode Go authentication is unavailable", "error");
        return;
      }

      pi.setThinkingLevel("max");

      try {
        pi.sendUserMessage("git commit");
      } catch (error) {
        await restorePreviousModel(ctx);
        ctx.ui.notify(
          `Could not start commit: ${error instanceof Error ? error.message : String(error)}`,
          "error",
        );
      }
    },
  });

  pi.on("agent_settled", async (_event, ctx) => {
    await restorePreviousModel(ctx);
  });
}
