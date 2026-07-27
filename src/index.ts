import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  pi.registerCommand("extension-dev-status", {
    description: "Confirm that the local extension workspace is loaded",
    handler: async (_args, ctx) => {
      ctx.ui.notify("Local extension workspace loaded", "info");
    },
  });
}
