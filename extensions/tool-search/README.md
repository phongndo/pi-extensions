# Pi Tool Search

> One flat `tool_search` entry point for discovering namespaced capability bundles and activating their tools additively.

Tool Search keeps specialized tool schemas out of the initial model context. Other extensions register searchable capabilities such as `web.batch`; the model calls `tool_search`, and matching tools become active on the following model request. Pi uses provider-native deferred definitions when supported and its normal active-tool fallback elsewhere.

## At a glance

|                  |                                                        |
| ---------------- | ------------------------------------------------------ |
| Model tool       | `tool_search`                                          |
| Status command   | `/tool-search`                                         |
| Activation       | Additive for the current session                       |
| Catalog identity | Namespaced capability IDs such as `web.research_state` |
| Search           | Deterministic weighted lexical ranking                 |
| Configuration    | Owned by each registering extension                    |

## Model usage

Search by task:

```json
{
  "query": "crawl linked documentation pages",
  "namespace": "web",
  "limit": 2
}
```

Load an exact known capability:

```json
{
  "query": "web.research_state"
}
```

An exact capability ID selects only that capability by default. Exact aliases outrank descriptive matches. A result activates only tools that are already registered with Pi. Unknown tool names are reported but never added.

## Registering capabilities

Import `registerToolCapabilities` from this package inside another extension:

```ts
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerToolCapabilities } from "pi-tool-search";

export default function (pi: ExtensionAPI) {
  pi.registerTool({ name: "issues_search" /* ... */ });

  registerToolCapabilities(pi, {
    source: "issues-extension",
    capabilities: [
      {
        id: "issues.search",
        description: "Search issue titles, bodies, labels, and comments.",
        aliases: ["find issues"],
        tags: ["github", "bugs", "tickets"],
        tools: ["issues_search"],
      },
    ],
  });
}
```

Capability IDs and sources use lowercase letters, numbers, dots, underscores, and hyphens. IDs must be unique across sources. Re-registering the same source atomically replaces that source's catalog.

### Dynamic availability

The owning extension remains responsible for configuration, credentials, permissions, and feature flags. Return currently available capability IDs when those settings can change:

```ts
registerToolCapabilities(pi, {
  source: "issues-extension",
  capabilities,
  resolveAvailable: async () => {
    const config = await loadConfig();
    return config.enabled ? ["issues.search"] : [];
  },
});
```

If availability resolution fails, Tool Search skips that source for the call and reports it in result details.

### Extension load order

`registerToolCapabilities()` reports whether Tool Search accepted a registration. Extensions that may load first can subscribe to readiness and retry:

```ts
import { onToolSearchReady, registerToolCapabilities } from "pi-tool-search";

const register = () => registerToolCapabilities(pi, registration);
const unsubscribe = onToolSearchReady(pi, register);
register();

pi.on("session_shutdown", unsubscribe);
```

## Search behavior

Ranking considers, in descending importance:

1. Exact capability IDs
2. Exact aliases
3. Capability-ID terms
4. Alias and tool-name terms
5. Tags
6. Description terms

Use concise, discriminative descriptions. Include likely user vocabulary in aliases or tags instead of inflating the model-facing system prompt.

The optional `namespace` filter restricts candidates to one namespace. Search returns at most five capabilities. Without `limit`, an exact capability ID returns one match and other searches return up to three.

## Cache behavior

Activation only adds tools to the current active set. It does not remove previously loaded tools. This lets Pi anchor newly loaded definitions at the search result on supported models and avoids unnecessary prompt-prefix churn.

Deferred tools should normally omit `promptSnippet` and `promptGuidelines`; adding active-only prompt metadata can still rebuild the system prompt even when tool schemas use native deferred loading.

## Status

```text
/tool-search
```

The command shows available capability IDs and any source whose dynamic availability could not be resolved. It does not activate tools.

## Security

Tool Search does not execute registered capabilities. It only activates tool definitions already known to Pi. The owning extension still controls execution, confirmation, network access, billing, and mutation policy.

Registrations are trusted in-process extension data. Pi extensions run with the user's permissions, so install only reviewed packages.

## Development

```bash
pnpm --filter pi-tool-search check
pnpm --filter pi-tool-search format
```

After editing, run `/reload` in Pi.
