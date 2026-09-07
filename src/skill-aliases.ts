import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export const skillAliases = {
  wayfinder: "wayfinder",
  "grill-me": "grill-me",
  handoff: "handoff",
  autopilot: "autopilot",
  yeet: "yeet",
} as const;

export function registerSkillAliases(pi: ExtensionAPI): void {
  for (const [alias, skill] of Object.entries(skillAliases)) {
    pi.registerCommand(alias, {
      description: `Alias for /skill:${skill}`,
      handler: async (args, ctx) => {
        if (
          !pi
            .getCommands()
            .some((command) => command.source === "skill" && command.name === `skill:${skill}`)
        ) {
          ctx.ui.notify(
            `Skill ${skill} is unavailable; enable skill commands and reload.`,
            "error",
          );
          return;
        }
        pi.sendUserMessage(`/skill:${skill}${args ? ` ${args}` : ""}`, {
          expandPromptTemplates: true,
          deliverAs: "followUp",
        });
      },
    });
  }
}
