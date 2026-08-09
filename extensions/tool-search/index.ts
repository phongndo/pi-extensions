import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const REGISTER_CHANNEL = "pi-tool-search:register";
const READY_CHANNEL = "pi-tool-search:ready";
const IDENTIFIER_PATTERN = /^[a-z0-9](?:[a-z0-9._-]{0,127})$/;
const TOOL_NAME_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

export interface ToolSearchCapability {
  /** Stable namespaced identifier, for example `web.batch`. */
  id: string;
  description: string;
  tools: readonly string[];
  aliases?: readonly string[];
  tags?: readonly string[];
}

export interface ToolSearchRegistration {
  /** Stable owner identifier used to replace registrations on reload. */
  source: string;
  capabilities: readonly ToolSearchCapability[];
  /** Omit to make every registered capability available. */
  resolveAvailable?: () => readonly string[] | Promise<readonly string[]>;
}

export interface ToolSearchRegistrationResult {
  accepted: boolean;
  errors: readonly string[];
}

interface RegistrationEnvelope {
  registration: ToolSearchRegistration;
  respond(result: ToolSearchRegistrationResult): void;
}

interface NormalizedCapability {
  id: string;
  description: string;
  tools: string[];
  aliases: string[];
  tags: string[];
}

interface StoredRegistration {
  source: string;
  capabilities: NormalizedCapability[];
  resolveAvailable?: ToolSearchRegistration["resolveAvailable"];
}

interface RankedCapability {
  source: string;
  capability: NormalizedCapability;
  score: number;
}

function uniqueNormalized(values: readonly string[] | undefined): string[] {
  return [
    ...new Set(
      (values ?? []).map((value) => value.trim().toLowerCase()).filter(Boolean),
    ),
  ];
}

function normalizedWords(value: string): string[] {
  return value
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

function validateRegistration(registration: ToolSearchRegistration): {
  stored?: StoredRegistration;
  errors: string[];
} {
  const errors: string[] = [];
  const source = registration.source.trim().toLowerCase();
  if (!IDENTIFIER_PATTERN.test(source))
    errors.push(`Invalid registration source: ${registration.source}`);
  if (registration.capabilities.length === 0)
    errors.push("A registration must contain at least one capability.");

  const seen = new Set<string>();
  const capabilities: NormalizedCapability[] = [];
  for (const candidate of registration.capabilities) {
    const id = candidate.id.trim().toLowerCase();
    const description = candidate.description.trim();
    const tools = [
      ...new Set(candidate.tools.map((tool) => tool.trim())),
    ].filter(Boolean);
    if (!IDENTIFIER_PATTERN.test(id)) {
      errors.push(`Invalid capability id: ${candidate.id}`);
      continue;
    }
    if (seen.has(id)) {
      errors.push(`Duplicate capability id in ${source}: ${id}`);
      continue;
    }
    seen.add(id);
    if (!description || description.length > 500)
      errors.push(`Capability ${id} needs a 1–500 character description.`);
    if (tools.length === 0)
      errors.push(`Capability ${id} must activate at least one tool.`);
    for (const tool of tools)
      if (!TOOL_NAME_PATTERN.test(tool))
        errors.push(`Capability ${id} has an invalid tool name: ${tool}`);
    capabilities.push({
      id,
      description,
      tools,
      aliases: uniqueNormalized(candidate.aliases),
      tags: uniqueNormalized(candidate.tags),
    });
  }

  if (errors.length > 0) return { errors };
  const stored: StoredRegistration = { source, capabilities };
  if (registration.resolveAvailable)
    stored.resolveAvailable = registration.resolveAvailable;
  return { stored, errors };
}

function scoreCapability(
  capability: NormalizedCapability,
  rawQuery: string,
): number {
  const query = rawQuery.trim().toLowerCase();
  if (query === capability.id) return 10_000;
  if (capability.aliases.includes(query)) return 9_000;

  const terms = [...new Set(normalizedWords(query))];
  if (terms.length === 0) return 0;
  const idWords = normalizedWords(capability.id);
  const aliasWords = capability.aliases.flatMap(normalizedWords);
  const tagWords = capability.tags.flatMap(normalizedWords);
  const descriptionWords = normalizedWords(capability.description);
  const toolWords = capability.tools.flatMap(normalizedWords);
  const allWords = new Set([
    ...idWords,
    ...aliasWords,
    ...tagWords,
    ...descriptionWords,
    ...toolWords,
  ]);

  let score = 0;
  let matchedTerms = 0;
  for (const term of terms) {
    let termScore = 0;
    if (idWords.includes(term)) termScore = Math.max(termScore, 12);
    if (aliasWords.includes(term)) termScore = Math.max(termScore, 10);
    if (toolWords.includes(term)) termScore = Math.max(termScore, 8);
    if (tagWords.includes(term)) termScore = Math.max(termScore, 6);
    if (descriptionWords.includes(term)) termScore = Math.max(termScore, 3);
    if (termScore === 0 && allWords.has(term)) termScore = 1;
    if (termScore > 0) matchedTerms++;
    score += termScore;
  }
  if (matchedTerms === terms.length) score += 20;
  const searchable = [
    capability.id,
    ...capability.aliases,
    ...capability.tags,
    ...capability.tools,
    capability.description,
  ]
    .join(" ")
    .toLowerCase();
  if (searchable.includes(query)) score += 15;
  return score;
}

async function availableCapabilities(
  registrations: Iterable<StoredRegistration>,
): Promise<{
  capabilities: Array<{ source: string; capability: NormalizedCapability }>;
  unavailableSources: string[];
}> {
  const capabilities: Array<{
    source: string;
    capability: NormalizedCapability;
  }> = [];
  const unavailableSources: string[] = [];
  await Promise.all(
    [...registrations].map(async (registration) => {
      let available: Set<string> | undefined;
      if (registration.resolveAvailable) {
        try {
          available = new Set(
            (await registration.resolveAvailable()).map((id) =>
              id.trim().toLowerCase(),
            ),
          );
        } catch {
          unavailableSources.push(registration.source);
          return;
        }
      }
      for (const capability of registration.capabilities)
        if (!available || available.has(capability.id))
          capabilities.push({ source: registration.source, capability });
    }),
  );
  return { capabilities, unavailableSources };
}

export function registerToolCapabilities(
  pi: ExtensionAPI,
  registration: ToolSearchRegistration,
): ToolSearchRegistrationResult {
  let result: ToolSearchRegistrationResult = {
    accepted: false,
    errors: ["The tool-search extension is not loaded."],
  };
  if (!pi.events) return result;
  pi.events.emit(REGISTER_CHANNEL, {
    registration,
    respond(response: ToolSearchRegistrationResult) {
      result = response;
    },
  } satisfies RegistrationEnvelope);
  return result;
}

export function onToolSearchReady(
  pi: ExtensionAPI,
  handler: () => void,
): () => void {
  if (!pi.events) return () => {};
  return pi.events.on(READY_CHANNEL, handler);
}

export default function toolSearchExtension(pi: ExtensionAPI): void {
  const registrations = new Map<string, StoredRegistration>();

  const unsubscribeRegistration = pi.events.on(REGISTER_CHANNEL, (data) => {
    const envelope = data as Partial<RegistrationEnvelope>;
    if (!envelope.registration || typeof envelope.respond !== "function")
      return;
    const validated = validateRegistration(envelope.registration);
    if (!validated.stored) {
      envelope.respond({ accepted: false, errors: validated.errors });
      return;
    }
    const incomingIds = new Set(
      validated.stored.capabilities.map((capability) => capability.id),
    );
    const conflicts = [...registrations.values()]
      .filter((entry) => entry.source !== validated.stored!.source)
      .flatMap((entry) =>
        entry.capabilities
          .filter((capability) => incomingIds.has(capability.id))
          .map(
            (capability) =>
              `Capability ${capability.id} is already registered by ${entry.source}.`,
          ),
      );
    if (conflicts.length > 0) {
      envelope.respond({ accepted: false, errors: conflicts });
      return;
    }
    registrations.set(validated.stored.source, validated.stored);
    envelope.respond({ accepted: true, errors: [] });
  });

  pi.registerTool({
    name: "tool_search",
    label: "Tool Search",
    description:
      "Search the registered capability catalog and enable tools relevant to a task. Use an exact namespaced capability id when known, such as web.batch or web.research_state. Activation is additive for prompt-cache stability.",
    promptSnippet:
      "Search for additional tools when the active tools cannot perform the task",
    promptGuidelines: [
      "Use tool_search when a task needs a capability that is not currently available; prefer an exact capability id when known and load only the smallest relevant set.",
    ],
    parameters: Type.Object(
      {
        query: Type.String({
          minLength: 1,
          maxLength: 500,
          description:
            "Capability, task, or exact namespaced capability id to search for.",
        }),
        namespace: Type.Optional(
          Type.String({
            minLength: 1,
            maxLength: 64,
            pattern: "^[a-z0-9][a-z0-9._-]*$",
            description:
              "Optional namespace filter such as web, review, or github.",
          }),
        ),
        limit: Type.Optional(
          Type.Integer({
            minimum: 1,
            maximum: 5,
            description:
              "Maximum capabilities to load. Defaults to 1 for an exact capability ID and 3 otherwise.",
          }),
        ),
      },
      { additionalProperties: false },
    ),
    executionMode: "sequential",
    async execute(_id, params) {
      const query = params.query.trim();
      const normalizedQuery = query.toLowerCase();
      const namespace = params.namespace?.trim().toLowerCase();
      const exactIdRequested = [...registrations.values()].some(
        (registration) =>
          registration.capabilities.some(
            (capability) => capability.id === normalizedQuery,
          ),
      );
      const resolved = await availableCapabilities(registrations.values());
      const ranked: RankedCapability[] = resolved.capabilities
        .filter(
          ({ capability }) =>
            !namespace ||
            capability.id === namespace ||
            capability.id.startsWith(`${namespace}.`),
        )
        .map(({ source, capability }) => ({
          source,
          capability,
          score: scoreCapability(capability, query),
        }))
        .filter((entry) => entry.score > 0)
        .sort(
          (left, right) =>
            right.score - left.score ||
            left.capability.id.localeCompare(right.capability.id),
        );
      const selected =
        params.limit === undefined && exactIdRequested
          ? ranked.filter((entry) => entry.capability.id === normalizedQuery)
          : ranked.slice(0, params.limit ?? 3);

      if (selected.length === 0) {
        return {
          content: [
            {
              type: "text",
              text: `No available capabilities matched: ${query}`,
            },
          ],
          details: {
            query,
            namespace,
            matches: [] as Array<{
              id: string;
              source: string;
              score: number;
              tools: string[];
            }>,
            added: [] as string[],
            missingTools: [] as string[],
            unavailableSources: resolved.unavailableSources,
          },
        };
      }

      const knownTools = new Set(pi.getAllTools().map((tool) => tool.name));
      const requestedTools = [
        ...new Set(selected.flatMap((entry) => entry.capability.tools)),
      ];
      const loadableTools = requestedTools.filter((name) =>
        knownTools.has(name),
      );
      const missingTools = requestedTools.filter(
        (name) => !knownTools.has(name),
      );
      const active = pi.getActiveTools();
      const added = loadableTools.filter((name) => !active.includes(name));
      if (added.length > 0)
        pi.setActiveTools([...new Set([...active, ...added])]);

      return {
        content: [
          {
            type: "text",
            text: [
              "Matched capabilities:",
              ...selected.map(
                ({ capability }) =>
                  `- ${capability.id}: ${capability.description}\n  tools: ${capability.tools.join(", ")}`,
              ),
              added.length > 0
                ? `Loaded tools: ${added.join(", ")}`
                : "All matching tools were already active.",
              ...(missingTools.length > 0
                ? [`Unavailable registered tools: ${missingTools.join(", ")}`]
                : []),
            ].join("\n"),
          },
        ],
        details: {
          query,
          namespace,
          matches: selected.map(({ source, capability, score }) => ({
            id: capability.id,
            source,
            score,
            tools: capability.tools,
          })),
          added,
          missingTools,
          unavailableSources: resolved.unavailableSources,
        },
      };
    },
  });

  pi.registerCommand("tool-search", {
    description: "Show registered deferred-tool capabilities",
    handler: async (_args, ctx) => {
      const resolved = await availableCapabilities(registrations.values());
      const ids = resolved.capabilities
        .map(({ capability }) => capability.id)
        .sort();
      const displayed = ids.slice(0, 100);
      ctx.ui.notify(
        [
          `Tool Search: ${ids.length} available capabilities from ${registrations.size} sources`,
          displayed.join(", ") || "No capabilities registered.",
          ...(ids.length > displayed.length
            ? [`…and ${ids.length - displayed.length} more.`]
            : []),
          ...(resolved.unavailableSources.length > 0
            ? [`Unavailable sources: ${resolved.unavailableSources.join(", ")}`]
            : []),
        ].join("\n"),
        "info",
      );
    },
  });

  pi.on("session_shutdown", () => {
    unsubscribeRegistration();
  });

  pi.events.emit(READY_CHANNEL, undefined);
}
