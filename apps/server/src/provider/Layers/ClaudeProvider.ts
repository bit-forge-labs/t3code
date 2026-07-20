import {
  type ClaudeSettings,
  type ModelCapabilities,
  type ModelSelection,
  type ServerProviderModel,
  type ServerProviderSlashCommand,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Result from "effect/Result";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import {
  createModelCapabilities,
  getModelSelectionStringOptionValue,
  getProviderOptionCurrentValue,
  getProviderOptionDescriptors,
  normalizeCustomModelSlug,
} from "@t3tools/shared/model";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import { compareSemverVersions } from "@t3tools/shared/semver";
import {
  query as claudeQuery,
  type SlashCommand as ClaudeSlashCommand,
  type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";

import {
  buildBooleanOptionDescriptor,
  buildSelectOptionDescriptor,
  buildServerProvider,
  DEFAULT_TIMEOUT_MS,
  isCommandMissingCause,
  parseGenericCliVersion,
  spawnAndCollect,
  type ServerProviderDraft,
} from "../providerSnapshot.ts";
import { resolveClaudeSdkExecutablePath } from "../Drivers/ClaudeExecutable.ts";
import { makeClaudeEnvironment } from "../Drivers/ClaudeHome.ts";
import {
  resolveClaudeModelsEndpoint,
  type ClaudeDiscoveredModel,
  type ClaudeModelDiscoveryOutcome,
} from "./ClaudeModelDiscovery.ts";

const DEFAULT_CLAUDE_MODEL_CAPABILITIES: ModelCapabilities = createModelCapabilities({
  optionDescriptors: [],
});

/**
 * Portable effort levels for models discovered from a custom gateway that
 * advertises reasoning support without enumerating specific levels, and for
 * manually configured proxy models. Deliberately excludes Claude-only controls
 * (`fastMode`, `thinking`) and prompt-injected modes (`ultrathink`,
 * `ultracode`) that do not translate to arbitrary upstream providers.
 */
const CLAUDE_PROXY_EFFORT_CAPABILITIES: ModelCapabilities = createModelCapabilities({
  optionDescriptors: [
    buildSelectOptionDescriptor({
      id: "effort",
      label: "Reasoning",
      options: [
        { value: "low", label: "Low" },
        { value: "medium", label: "Medium" },
        { value: "high", label: "High", isDefault: true },
        { value: "max", label: "Max" },
      ],
    }),
  ],
});

/** Friendly labels for known reasoning-effort values; others are title-cased. */
function claudeEffortLabel(value: string): string {
  switch (value.toLowerCase()) {
    case "minimal":
      return "Minimal";
    case "none":
      return "None";
    case "low":
      return "Low";
    case "medium":
      return "Medium";
    case "high":
      return "High";
    case "xhigh":
      return "Extra High";
    case "max":
      return "Max";
    case "ultra":
      return "Ultra";
    case "auto":
      return "Auto";
    default:
      return toTitleCaseWords(value);
  }
}

/**
 * Build capabilities for a model discovered from a custom gateway. Effort
 * controls come from the gateway's advertised reasoning levels; context limits
 * are attached as read-only metadata. Models discovered without reasoning levels
 * (the minimal `/v1/models` tier) fall back to the portable effort set only when
 * the instance is gateway-backed, otherwise remain capability-empty.
 */
function buildDiscoveredClaudeModelCapabilities(
  discovered: ClaudeDiscoveredModel,
  gatewayBacked: boolean,
): ModelCapabilities {
  const optionDescriptors =
    discovered.effortLevels && discovered.effortLevels.length > 0
      ? [
          buildSelectOptionDescriptor({
            id: "effort",
            label: "Reasoning",
            options: discovered.effortLevels.map((level) => ({
              value: level.value,
              label: claudeEffortLabel(level.value),
              ...(level.description ? { description: level.description } : {}),
              ...(level.isDefault ? { isDefault: true } : {}),
            })),
          }),
        ]
      : gatewayBacked
        ? [...(CLAUDE_PROXY_EFFORT_CAPABILITIES.optionDescriptors ?? [])]
        : [];

  return createModelCapabilities({
    optionDescriptors,
    ...(discovered.contextWindowTokens !== undefined
      ? { contextWindowTokens: discovered.contextWindowTokens }
      : {}),
    ...(discovered.maxContextWindowTokens !== undefined
      ? { maxContextWindowTokens: discovered.maxContextWindowTokens }
      : {}),
  });
}

/**
 * Augment a built-in Claude model with read-only context metadata (and, when the
 * gateway advertises them, replaced effort levels) from its discovered twin,
 * without disturbing the model's tested static controls or ordering.
 */
function augmentBuiltInWithDiscovery(
  builtIn: ServerProviderModel,
  discovered: ClaudeDiscoveredModel,
): ServerProviderModel {
  const baseCaps = builtIn.capabilities ?? DEFAULT_CLAUDE_MODEL_CAPABILITIES;
  const baseDescriptors = baseCaps.optionDescriptors ?? [];
  const descriptors =
    discovered.effortLevels && discovered.effortLevels.length > 0
      ? baseDescriptors.map((descriptor) =>
          descriptor.type === "select" && descriptor.id === "effort"
            ? buildSelectOptionDescriptor({
                id: "effort",
                label: descriptor.label,
                options: discovered.effortLevels!.map((level) => ({
                  value: level.value,
                  label: claudeEffortLabel(level.value),
                  ...(level.description ? { description: level.description } : {}),
                  ...(level.isDefault ? { isDefault: true } : {}),
                })),
                ...(descriptor.promptInjectedValues
                  ? { promptInjectedValues: [...descriptor.promptInjectedValues] }
                  : {}),
              })
            : descriptor,
        )
      : baseDescriptors;

  return {
    ...builtIn,
    ...(discovered.description ? { description: discovered.description } : {}),
    capabilities: createModelCapabilities({
      optionDescriptors: descriptors,
      ...(discovered.contextWindowTokens !== undefined
        ? { contextWindowTokens: discovered.contextWindowTokens }
        : {}),
      ...(discovered.maxContextWindowTokens !== undefined
        ? { maxContextWindowTokens: discovered.maxContextWindowTokens }
        : {}),
    }),
  };
}

const CLAUDE_PRESENTATION = {
  displayName: "Claude",
  showInteractionModeToggle: true,
} as const;
const MINIMUM_CLAUDE_FABLE_5_VERSION = "2.1.169";
const MINIMUM_CLAUDE_OPUS_4_8_VERSION = "2.1.154";
const MINIMUM_CLAUDE_OPUS_4_7_VERSION = "2.1.111";

const BUILT_IN_MODELS: ReadonlyArray<ServerProviderModel> = [
  {
    slug: "claude-fable-5",
    name: "Claude Fable 5",
    isCustom: false,
    capabilities: createModelCapabilities({
      optionDescriptors: [
        buildSelectOptionDescriptor({
          id: "effort",
          label: "Reasoning",
          options: [
            { value: "low", label: "Low" },
            { value: "medium", label: "Medium" },
            { value: "high", label: "High", isDefault: true },
            { value: "xhigh", label: "Extra High" },
            { value: "max", label: "Max" },
            { value: "ultracode", label: "Ultracode" },
            { value: "ultrathink", label: "Ultrathink" },
          ],
          promptInjectedValues: ["ultrathink"],
        }),
        buildSelectOptionDescriptor({
          id: "contextWindow",
          label: "Context Window",
          options: [
            { value: "200k", label: "200k", isDefault: true },
            { value: "1m", label: "1M" },
          ],
        }),
      ],
    }),
  },
  {
    slug: "claude-opus-4-8",
    name: "Claude Opus 4.8",
    isCustom: false,
    capabilities: createModelCapabilities({
      optionDescriptors: [
        buildSelectOptionDescriptor({
          id: "effort",
          label: "Reasoning",
          options: [
            { value: "low", label: "Low" },
            { value: "medium", label: "Medium" },
            { value: "high", label: "High", isDefault: true },
            { value: "xhigh", label: "Extra High" },
            { value: "max", label: "Max" },
            { value: "ultracode", label: "Ultracode" },
            { value: "ultrathink", label: "Ultrathink" },
          ],
          promptInjectedValues: ["ultrathink"],
        }),
        buildBooleanOptionDescriptor({
          id: "fastMode",
          label: "Fast Mode",
        }),
      ],
    }),
  },
  {
    slug: "claude-opus-4-7",
    name: "Claude Opus 4.7",
    isCustom: false,
    capabilities: createModelCapabilities({
      optionDescriptors: [
        buildSelectOptionDescriptor({
          id: "effort",
          label: "Reasoning",
          options: [
            { value: "low", label: "Low" },
            { value: "medium", label: "Medium" },
            { value: "high", label: "High" },
            { value: "xhigh", label: "Extra High", isDefault: true },
            { value: "max", label: "Max" },
            { value: "ultrathink", label: "Ultrathink" },
          ],
          promptInjectedValues: ["ultrathink"],
        }),
        buildBooleanOptionDescriptor({
          id: "fastMode",
          label: "Fast Mode",
        }),
      ],
    }),
  },
  {
    slug: "claude-opus-4-6",
    name: "Claude Opus 4.6",
    isCustom: false,
    capabilities: createModelCapabilities({
      optionDescriptors: [
        buildSelectOptionDescriptor({
          id: "effort",
          label: "Reasoning",
          options: [
            { value: "low", label: "Low" },
            { value: "medium", label: "Medium" },
            { value: "high", label: "High", isDefault: true },
            { value: "max", label: "Max" },
            { value: "ultrathink", label: "Ultrathink" },
          ],
          promptInjectedValues: ["ultrathink"],
        }),
        buildBooleanOptionDescriptor({
          id: "fastMode",
          label: "Fast Mode",
        }),
        buildSelectOptionDescriptor({
          id: "contextWindow",
          label: "Context Window",
          options: [
            { value: "200k", label: "200k", isDefault: true },
            { value: "1m", label: "1M" },
          ],
        }),
      ],
    }),
  },
  {
    slug: "claude-opus-4-5",
    name: "Claude Opus 4.5",
    isCustom: false,
    capabilities: createModelCapabilities({
      optionDescriptors: [
        buildSelectOptionDescriptor({
          id: "effort",
          label: "Reasoning",
          options: [
            { value: "low", label: "Low" },
            { value: "medium", label: "Medium" },
            { value: "high", label: "High", isDefault: true },
            { value: "max", label: "Max" },
          ],
        }),
        buildBooleanOptionDescriptor({
          id: "fastMode",
          label: "Fast Mode",
        }),
      ],
    }),
  },
  {
    slug: "claude-sonnet-5",
    name: "Claude Sonnet 5",
    isCustom: false,
    capabilities: createModelCapabilities({
      optionDescriptors: [
        buildSelectOptionDescriptor({
          id: "effort",
          label: "Reasoning",
          options: [
            { value: "low", label: "Low" },
            { value: "medium", label: "Medium" },
            { value: "high", label: "High", isDefault: true },
            { value: "xhigh", label: "Extra High" },
            { value: "max", label: "Max" },
            { value: "ultrathink", label: "Ultrathink" },
          ],
          promptInjectedValues: ["ultrathink"],
        }),
        buildSelectOptionDescriptor({
          id: "contextWindow",
          label: "Context Window",
          options: [
            { value: "200k", label: "200k", isDefault: true },
            { value: "1m", label: "1M" },
          ],
        }),
      ],
    }),
  },
  {
    slug: "claude-sonnet-4-6",
    name: "Claude Sonnet 4.6",
    isCustom: false,
    capabilities: createModelCapabilities({
      optionDescriptors: [
        buildSelectOptionDescriptor({
          id: "effort",
          label: "Reasoning",
          options: [
            { value: "low", label: "Low" },
            { value: "medium", label: "Medium" },
            { value: "high", label: "High", isDefault: true },
            { value: "max", label: "Max" },
            { value: "ultrathink", label: "Ultrathink" },
          ],
          promptInjectedValues: ["ultrathink"],
        }),
        buildSelectOptionDescriptor({
          id: "contextWindow",
          label: "Context Window",
          options: [
            { value: "200k", label: "200k", isDefault: true },
            { value: "1m", label: "1M" },
          ],
        }),
      ],
    }),
  },
  {
    slug: "claude-haiku-4-5",
    name: "Claude Haiku 4.5",
    isCustom: false,
    capabilities: createModelCapabilities({
      optionDescriptors: [
        buildBooleanOptionDescriptor({
          id: "thinking",
          label: "Thinking",
        }),
      ],
    }),
  },
];

function supportsClaudeFable5(version: string | null | undefined): boolean {
  return version ? compareSemverVersions(version, MINIMUM_CLAUDE_FABLE_5_VERSION) >= 0 : false;
}

function supportsClaudeOpus48(version: string | null | undefined): boolean {
  return version ? compareSemverVersions(version, MINIMUM_CLAUDE_OPUS_4_8_VERSION) >= 0 : false;
}

function supportsClaudeOpus47(version: string | null | undefined): boolean {
  return version ? compareSemverVersions(version, MINIMUM_CLAUDE_OPUS_4_7_VERSION) >= 0 : false;
}

function getBuiltInClaudeModelsForVersion(
  version: string | null | undefined,
): ReadonlyArray<ServerProviderModel> {
  return BUILT_IN_MODELS.filter((model) => {
    if (model.slug === "claude-fable-5") {
      return supportsClaudeFable5(version);
    }
    if (model.slug === "claude-opus-4-8") {
      return supportsClaudeOpus48(version);
    }
    if (model.slug === "claude-opus-4-7") {
      return supportsClaudeOpus47(version);
    }
    return true;
  });
}

function formatClaudeFable5UpgradeMessage(version: string | null): string {
  const versionLabel = version ? `v${version}` : "the installed version";
  return `Claude Code ${versionLabel} is too old for Claude Fable 5. Upgrade to v${MINIMUM_CLAUDE_FABLE_5_VERSION} or newer to access it.`;
}

function formatClaudeOpus48UpgradeMessage(version: string | null): string {
  const versionLabel = version ? `v${version}` : "the installed version";
  return `Claude Code ${versionLabel} is too old for Claude Opus 4.8. Upgrade to v${MINIMUM_CLAUDE_OPUS_4_8_VERSION} or newer to access it.`;
}

function formatClaudeOpus47UpgradeMessage(version: string | null): string {
  const versionLabel = version ? `v${version}` : "the installed version";
  return `Claude Code ${versionLabel} is too old for Claude Opus 4.7. Upgrade to v${MINIMUM_CLAUDE_OPUS_4_7_VERSION} or newer to access it.`;
}

/**
 * Resolve capabilities for a Claude model slug. Resolution order:
 *   1. Exact built-in Claude model capabilities.
 *   2. Caller-supplied instance fallback (e.g. portable proxy effort for a
 *      gateway-backed instance).
 *   3. Empty capabilities.
 */
export function getClaudeModelCapabilities(
  model: string | null | undefined,
  fallbackCapabilities: ModelCapabilities = DEFAULT_CLAUDE_MODEL_CAPABILITIES,
): ModelCapabilities {
  const slug = model?.trim();
  return (
    BUILT_IN_MODELS.find((candidate) => candidate.slug === slug)?.capabilities ??
    fallbackCapabilities
  );
}

/** The portable effort capabilities used for unknown models on a gateway. */
export function claudeProxyEffortCapabilities(): ModelCapabilities {
  return CLAUDE_PROXY_EFFORT_CAPABILITIES;
}

/**
 * Merge built-ins, gateway-discovered models, and manually configured custom
 * models into a single ordered, de-duplicated catalog.
 *
 * When `discoverySucceeded` is true the gateway's catalog is **authoritative**:
 * only models the proxy actually reports are listed — a built-in `claude-*`
 * model that the proxy does not serve is never shown, since the static allowlist
 * is a first-party assumption that does not hold behind an arbitrary gateway.
 * Discovered models matching a built-in keep the built-in's tested capabilities
 * (augmented with discovered metadata); the rest use discovered/portable caps.
 *
 * When `discoverySucceeded` is false (no gateway, or discovery failed/again
 * pending) the static built-in catalog is shown as the fallback.
 *
 * Ordering: built-in models the proxy serves (canonical order) → remaining
 * discovered models (gateway order) → manual custom models (settings order).
 * Manual entries duplicating an existing slug are dropped; manual models on a
 * gateway-backed instance receive the portable effort fallback.
 */
export function mergeClaudeModelsWithDiscovery(input: {
  readonly builtInModels: ReadonlyArray<ServerProviderModel>;
  readonly discoveredModels: ReadonlyArray<ClaudeDiscoveredModel>;
  readonly customModels: ReadonlyArray<string>;
  readonly gatewayBacked: boolean;
  readonly discoverySucceeded: boolean;
}): ReadonlyArray<ServerProviderModel> {
  const builtInBySlug = new Map(input.builtInModels.map((model) => [model.slug, model]));
  const discoveredBySlug = new Map(input.discoveredModels.map((model) => [model.slug, model]));

  const merged: Array<ServerProviderModel> = [];
  const seen = new Set<string>();

  if (input.discoverySucceeded) {
    // Authoritative gateway catalog. Built-ins the proxy actually serves first
    // (canonical order, augmented), then the rest of the discovered models.
    for (const builtIn of input.builtInModels) {
      const discovered = discoveredBySlug.get(builtIn.slug);
      if (discovered) {
        seen.add(builtIn.slug);
        merged.push(augmentBuiltInWithDiscovery(builtIn, discovered));
      }
    }
    for (const discovered of input.discoveredModels) {
      if (seen.has(discovered.slug) || builtInBySlug.has(discovered.slug)) {
        continue;
      }
      seen.add(discovered.slug);
      merged.push({
        slug: discovered.slug,
        name: discovered.name,
        ...(discovered.description ? { description: discovered.description } : {}),
        isCustom: false,
        capabilities: buildDiscoveredClaudeModelCapabilities(discovered, input.gatewayBacked),
      });
    }
  } else {
    // No gateway, or discovery failed / not yet run: static built-in catalog.
    for (const builtIn of input.builtInModels) {
      seen.add(builtIn.slug);
      merged.push(builtIn);
    }
  }

  // Manual custom models not already present.
  const manualCapabilities = input.gatewayBacked
    ? CLAUDE_PROXY_EFFORT_CAPABILITIES
    : DEFAULT_CLAUDE_MODEL_CAPABILITIES;
  for (const candidate of input.customModels) {
    // Custom slugs are provider-owned: trim only, never alias-expand (matches
    // upstream `providerModelsFromSettings` / "preserve custom model slugs").
    const normalized = normalizeCustomModelSlug(candidate);
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    merged.push({
      slug: normalized,
      name: normalized,
      isCustom: true,
      capabilities: manualCapabilities,
    });
  }

  return merged;
}

/**
 * Resolve instance-aware capabilities for a model at runtime, consulting a
 * discovery outcome for gateway models. Built-ins always win; discovered models
 * use their advertised effort/context; unknown models fall back to the portable
 * proxy set on a gateway-backed instance, else empty.
 */
export function resolveClaudeModelCapabilitiesForInstance(input: {
  readonly model: string | null | undefined;
  readonly discovery: ClaudeModelDiscoveryOutcome | undefined;
  readonly gatewayBacked: boolean;
}): ModelCapabilities {
  const slug = input.model?.trim();
  const builtIn = slug ? BUILT_IN_MODELS.find((candidate) => candidate.slug === slug) : undefined;
  if (builtIn) {
    return builtIn.capabilities ?? DEFAULT_CLAUDE_MODEL_CAPABILITIES;
  }

  if (slug && input.discovery?.kind === "discovered") {
    const discovered = input.discovery.models.find((candidate) => candidate.slug === slug);
    if (discovered) {
      return buildDiscoveredClaudeModelCapabilities(discovered, input.gatewayBacked);
    }
  }

  return input.gatewayBacked ? CLAUDE_PROXY_EFFORT_CAPABILITIES : DEFAULT_CLAUDE_MODEL_CAPABILITIES;
}

export function resolveClaudeEffort(
  caps: ModelCapabilities,
  raw: string | null | undefined,
): string | undefined {
  const descriptors = getProviderOptionDescriptors({
    caps,
    ...(raw ? { selections: [{ id: "effort", value: raw }] } : {}),
  });
  const effortDescriptor = descriptors.find((descriptor) => descriptor.id === "effort");
  const value = getProviderOptionCurrentValue(effortDescriptor);
  return typeof value === "string" ? value : undefined;
}

/**
 * Normalize a resolved Claude effort value into one suitable for the Claude
 * CLI's `--effort` flag.
 *
 * Mirrors the mapping used when invoking the Claude Agent SDK
 * ({@link getEffectiveClaudeAgentEffort} in ClaudeAdapter): `ultracode` is a
 * Claude Code setting that pairs with `xhigh`, `ultrathink` is filtered out
 * because it is a prompt-prefix mode, and older model compatibility mappings
 * are preserved for current Claude Code behavior.
 */
export function normalizeClaudeCliEffort(
  effort: string | null | undefined,
  model: string | null | undefined,
): string | undefined {
  if (!effort || effort === "ultrathink") {
    return undefined;
  }
  if (effort === "ultracode") {
    return "xhigh";
  }
  if (
    effort === "xhigh" &&
    model !== "claude-fable-5" &&
    model !== "claude-opus-4-8" &&
    model !== "claude-sonnet-5"
  ) {
    return "max";
  }
  if (effort === "max" && model === "claude-sonnet-4-6") {
    return "high";
  }
  return effort;
}

export function isClaudeUltracodeEffort(effort: string | null | undefined): boolean {
  return effort === "ultracode";
}

/** Whether a slug is a built-in (first-party Anthropic) Claude model. */
export function isBuiltInClaudeModel(model: string | null | undefined): boolean {
  const slug = model?.trim();
  return slug ? BUILT_IN_MODELS.some((candidate) => candidate.slug === slug) : false;
}

export function resolveClaudeApiModelId(modelSelection: ModelSelection): string {
  // The `[1m]` context-window suffix is Claude Code routing syntax and must only
  // be applied to first-party Claude models. A discovered gateway model never
  // exposes a selectable context option, but a stale stored selection could
  // still carry `contextWindow: "1m"` — guard against appending it to a
  // non-Anthropic model id.
  if (
    isBuiltInClaudeModel(modelSelection.model) &&
    getModelSelectionStringOptionValue(modelSelection, "contextWindow") === "1m"
  ) {
    return `${modelSelection.model}[1m]`;
  }
  return modelSelection.model;
}

function toTitleCaseWords(value: string): string {
  const parts: Array<string> = [];
  for (const part of value.split(/[\s_-]+/g)) {
    if (part.length > 0) {
      parts.push(part[0]!.toUpperCase() + part.slice(1).toLowerCase());
    }
  }
  return parts.join(" ");
}

function claudeSubscriptionLabel(subscriptionType: string | undefined): string | undefined {
  const normalized = subscriptionType?.toLowerCase().replace(/[\s_-]+/g, "");
  if (!normalized) return undefined;

  switch (normalized) {
    case "claudemaxsubscription":
      return "Max";
    case "claudemax5xsubscription":
      return "Max 5x";
    case "claudemax20xsubscription":
      return "Max 20x";
    case "claudeenterprisesubscription":
      return "Enterprise";
    case "claudeteamsubscription":
      return "Team";
    case "claudeprosubscription":
      return "Pro";
    case "claudefreesubscription":
      return "Free";
    case "max":
    case "maxplan":
      return "Max";
    case "max5":
      return "Max 5x";
    case "max20":
      return "Max 20x";
    case "enterprise":
      return "Enterprise";
    case "team":
      return "Team";
    case "pro":
      return "Pro";
    case "free":
      return "Free";
    default:
      return toTitleCaseWords(subscriptionType!);
  }
}

function normalizeClaudeAuthMethod(authMethod: string | undefined): string | undefined {
  const normalized = authMethod?.toLowerCase().replace(/[\s_-]+/g, "");
  if (!normalized) return undefined;
  if (
    normalized === "apikey" ||
    normalized === "anthropicapikey" ||
    normalized === "anthropicauthtoken"
  ) {
    return "apiKey";
  }
  return undefined;
}

function formatClaudeSubscriptionAuthLabel(subscriptionType: string): string {
  const subscriptionLabel =
    claudeSubscriptionLabel(subscriptionType) ?? toTitleCaseWords(subscriptionType);
  const normalized = subscriptionLabel.toLowerCase().replace(/[\s_-]+/g, "");

  if (normalized.startsWith("claude") && normalized.endsWith("subscription")) {
    return subscriptionLabel;
  }
  if (normalized.startsWith("claude")) {
    return `${subscriptionLabel} Subscription`;
  }
  if (normalized.endsWith("subscription")) {
    return `Claude ${subscriptionLabel}`;
  }
  return `Claude ${subscriptionLabel} Subscription`;
}

function claudeAuthMetadata(input: {
  readonly subscriptionType: string | undefined;
  readonly authMethod: string | undefined;
}): { readonly type: string; readonly label: string } | undefined {
  if (normalizeClaudeAuthMethod(input.authMethod) === "apiKey") {
    return {
      type: "apiKey",
      label: "Claude API Key",
    };
  }

  if (input.subscriptionType) {
    return {
      type: input.subscriptionType,
      label: formatClaudeSubscriptionAuthLabel(input.subscriptionType),
    };
  }

  return undefined;
}

function apiProviderAuthMetadata(
  apiProvider: string | undefined,
): { readonly type: string; readonly label: string } | undefined {
  return apiProvider === "bedrock" ? { type: "bedrock", label: "Amazon Bedrock" } : undefined;
}

// ── SDK capability probe ────────────────────────────────────────────

// Amazon Bedrock initializes far slower than first-party auth: the SDK boots the
// Bedrock backend and runs the `awsAuthRefresh` credential hook before returning
// account info. The previous 8s budget expired mid-init, so the probe returned
// `undefined` and left the provider unverified and unselectable in the picker.
const CAPABILITIES_PROBE_TIMEOUT_MS = 25_000;

function nonEmptyProbeString(value: string): string | undefined {
  const candidate = value.trim();
  return candidate ? candidate : undefined;
}

type ClaudeCapabilitiesProbe = {
  readonly email: string | undefined;
  readonly subscriptionType: string | undefined;
  readonly tokenSource: string | undefined;
  /**
   * Active API backend reported by the SDK's `AccountInfo`. Anthropic OAuth
   * login only applies when `"firstParty"`; for Amazon Bedrock (`"bedrock"`)
   * the subscription/token fields are absent and auth is external AWS creds.
   */
  readonly apiProvider: string | undefined;
  readonly slashCommands: ReadonlyArray<ServerProviderSlashCommand>;
};

function parseClaudeInitializationCommands(
  commands: ReadonlyArray<ClaudeSlashCommand> | undefined,
): ReadonlyArray<ServerProviderSlashCommand> {
  return dedupeSlashCommands(
    (commands ?? []).flatMap((command) => {
      const name = nonEmptyProbeString(command.name);
      if (!name) {
        return [];
      }

      const description = nonEmptyProbeString(command.description);
      const argumentHint = nonEmptyProbeString(command.argumentHint);

      return [
        {
          name,
          ...(description ? { description } : {}),
          ...(argumentHint ? { input: { hint: argumentHint } } : {}),
        } satisfies ServerProviderSlashCommand,
      ];
    }),
  );
}

function dedupeSlashCommands(
  commands: ReadonlyArray<ServerProviderSlashCommand>,
): ReadonlyArray<ServerProviderSlashCommand> {
  const commandsByName = new Map<string, ServerProviderSlashCommand>();

  for (const command of commands) {
    const name = nonEmptyProbeString(command.name);
    if (!name) {
      continue;
    }

    const key = name.toLowerCase();
    const existing = commandsByName.get(key);
    if (!existing) {
      commandsByName.set(key, {
        ...command,
        name,
      });
      continue;
    }

    commandsByName.set(key, {
      ...existing,
      ...(existing.description
        ? {}
        : command.description
          ? { description: command.description }
          : {}),
      ...(existing.input?.hint
        ? {}
        : command.input?.hint
          ? { input: { hint: command.input.hint } }
          : {}),
    });
  }

  return [...commandsByName.values()];
}

function waitForAbortSignal(signal: AbortSignal): Promise<void> {
  if (signal.aborted) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    signal.addEventListener("abort", () => resolve(), { once: true });
  });
}

/**
 * Probe account information by spawning a lightweight Claude Agent SDK
 * session and reading the initialization result.
 *
 * We pass a never-yielding AsyncIterable as the prompt so that no user
 * message is ever written to the subprocess stdin. This means the Claude
 * Code subprocess completes its local initialization IPC (returning
 * account info and slash commands) but never starts an API request to
 * Anthropic. We read the init data and then abort the subprocess.
 *
 * This is used as a fallback when `claude auth status` does not include
 * subscription type information.
 */
const probeClaudeCapabilities = (
  claudeSettings: ClaudeSettings,
  environment?: NodeJS.ProcessEnv,
  cwd?: string,
) => {
  const abort = new AbortController();
  return Effect.gen(function* () {
    const claudeEnvironment = yield* makeClaudeEnvironment(claudeSettings, environment);
    const executablePath = yield* resolveClaudeSdkExecutablePath(
      claudeSettings.binaryPath,
      claudeEnvironment,
    );
    return yield* Effect.tryPromise(async () => {
      const q = claudeQuery({
        // Never yield — we only need initialization data, not a conversation.
        // This prevents any prompt from reaching the Anthropic API.
        // oxlint-disable-next-line require-yield
        prompt: (async function* (): AsyncGenerator<SDKUserMessage> {
          await waitForAbortSignal(abort.signal);
        })(),
        options: {
          persistSession: false,
          pathToClaudeCodeExecutable: executablePath,
          abortController: abort,
          settingSources: ["user", "project", "local"],
          allowedTools: [],
          env: claudeEnvironment,
          ...(cwd ? { cwd } : {}),
          stderr: () => {},
        },
      });
      const init = await q.initializationResult();
      const account = init.account as
        | {
            readonly email?: string;
            readonly subscriptionType?: string;
            readonly tokenSource?: string;
            readonly apiProvider?: string;
          }
        | undefined;
      return {
        email: account?.email,
        subscriptionType: account?.subscriptionType,
        tokenSource: account?.tokenSource,
        apiProvider: account?.apiProvider,
        slashCommands: parseClaudeInitializationCommands(init.commands),
      } satisfies ClaudeCapabilitiesProbe;
    });
  }).pipe(
    Effect.ensuring(
      Effect.sync(() => {
        if (!abort.signal.aborted) abort.abort();
      }),
    ),
    Effect.timeoutOption(CAPABILITIES_PROBE_TIMEOUT_MS),
    Effect.result,
    Effect.map((result) => {
      if (Result.isFailure(result)) return undefined;
      return Option.isSome(result.success) ? result.success.value : undefined;
    }),
  );
};

const runClaudeCommand = Effect.fn("runClaudeCommand")(function* (
  claudeSettings: ClaudeSettings,
  args: ReadonlyArray<string>,
  environment?: NodeJS.ProcessEnv,
) {
  const claudeEnvironment = yield* makeClaudeEnvironment(claudeSettings, environment);
  const spawnCommand = yield* resolveSpawnCommand(claudeSettings.binaryPath, args, {
    env: claudeEnvironment,
  });
  const command = ChildProcess.make(spawnCommand.command, spawnCommand.args, {
    env: claudeEnvironment,
    shell: spawnCommand.shell,
  });
  return yield* spawnAndCollect(claudeSettings.binaryPath, command);
});

export const checkClaudeProviderStatus = Effect.fn("checkClaudeProviderStatus")(function* (
  claudeSettings: ClaudeSettings,
  resolveCapabilities?: (
    claudeSettings: ClaudeSettings,
  ) => Effect.Effect<ClaudeCapabilitiesProbe | undefined>,
  environment?: NodeJS.ProcessEnv,
  resolveDiscovery?: () => Effect.Effect<ClaudeModelDiscoveryOutcome>,
): Effect.fn.Return<
  ServerProviderDraft,
  never,
  ChildProcessSpawner.ChildProcessSpawner | Path.Path
> {
  const resolvedEnvironment = environment ?? process.env;
  const gatewayBacked =
    resolveClaudeModelsEndpoint(resolvedEnvironment.ANTHROPIC_BASE_URL) !== null;
  const checkedAt = DateTime.formatIso(yield* DateTime.now);
  const buildClaudeModels = (
    builtInModels: ReadonlyArray<ServerProviderModel>,
    discoveredModels: ReadonlyArray<ClaudeDiscoveredModel>,
    discoverySucceeded: boolean,
  ): ReadonlyArray<ServerProviderModel> =>
    mergeClaudeModelsWithDiscovery({
      builtInModels,
      discoveredModels,
      customModels: claudeSettings.customModels,
      gatewayBacked,
      discoverySucceeded,
    });
  const allModels = buildClaudeModels(BUILT_IN_MODELS, [], false);

  if (!claudeSettings.enabled) {
    return buildServerProvider({
      presentation: CLAUDE_PRESENTATION,
      enabled: false,
      checkedAt,
      models: allModels,
      probe: {
        installed: false,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: "Claude is disabled in T3 Code settings.",
      },
    });
  }

  const versionProbe = yield* runClaudeCommand(
    claudeSettings,
    ["--version"],
    resolvedEnvironment,
  ).pipe(Effect.timeoutOption(DEFAULT_TIMEOUT_MS), Effect.result);

  if (Result.isFailure(versionProbe)) {
    const error = versionProbe.failure;
    yield* Effect.logWarning("Claude Agent CLI health check failed.", {
      errorTag: error._tag,
    });
    return buildServerProvider({
      presentation: CLAUDE_PRESENTATION,
      enabled: claudeSettings.enabled,
      checkedAt,
      models: allModels,
      probe: {
        installed: !isCommandMissingCause(error),
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message: isCommandMissingCause(error)
          ? "Claude Agent CLI (`claude`) is not installed or not on PATH."
          : "Failed to execute Claude Agent CLI health check.",
      },
    });
  }

  if (Option.isNone(versionProbe.success)) {
    return buildServerProvider({
      presentation: CLAUDE_PRESENTATION,
      enabled: claudeSettings.enabled,
      checkedAt,
      models: allModels,
      probe: {
        installed: true,
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message:
          "Claude Agent CLI is installed but failed to run. Timed out while running command.",
      },
    });
  }

  const version = versionProbe.success.value;
  const parsedVersion = parseGenericCliVersion(`${version.stdout}\n${version.stderr}`);
  if (version.code !== 0) {
    yield* Effect.logWarning("Claude Agent CLI version probe exited with a non-zero status.", {
      exitCode: version.code,
      stdoutLength: version.stdout.length,
      stderrLength: version.stderr.length,
    });
    return buildServerProvider({
      presentation: CLAUDE_PRESENTATION,
      enabled: claudeSettings.enabled,
      checkedAt,
      models: allModels,
      probe: {
        installed: true,
        version: parsedVersion,
        status: "error",
        auth: { status: "unknown" },
        message: "Claude Agent CLI is installed but failed to run.",
      },
    });
  }

  const versionBuiltIns = getBuiltInClaudeModelsForVersion(parsedVersion);
  const models = buildClaudeModels(versionBuiltIns, [], false);
  const versionUpgradeMessage = supportsClaudeFable5(parsedVersion)
    ? undefined
    : supportsClaudeOpus48(parsedVersion)
      ? formatClaudeFable5UpgradeMessage(parsedVersion)
      : supportsClaudeOpus47(parsedVersion)
        ? formatClaudeOpus48UpgradeMessage(parsedVersion)
        : formatClaudeOpus47UpgradeMessage(parsedVersion);

  const capabilities = resolveCapabilities
    ? yield* resolveCapabilities(claudeSettings).pipe(Effect.orElseSucceed(() => undefined))
    : undefined;
  const slashCommands = capabilities?.slashCommands ?? [];
  const dedupedSlashCommands = dedupeSlashCommands(slashCommands);

  if (!capabilities) {
    return buildServerProvider({
      presentation: CLAUDE_PRESENTATION,
      enabled: claudeSettings.enabled,
      checkedAt,
      models,
      slashCommands: dedupedSlashCommands,
      probe: {
        installed: true,
        version: parsedVersion,
        status: "warning",
        auth: { status: "unknown" },
        message: "Could not verify Claude authentication status from initialization result.",
      },
    });
  }

  const authMetadata =
    claudeAuthMetadata({
      subscriptionType: capabilities.subscriptionType,
      authMethod: capabilities.tokenSource,
    }) ?? apiProviderAuthMetadata(capabilities.apiProvider);

  // Model discovery only applies to a custom gateway (not first-party Anthropic
  // or Bedrock, which authenticates via external AWS creds and serves only
  // Anthropic models). A discovery failure keeps the built-in/manual catalog and
  // downgrades an otherwise-ready snapshot to `warning`, but never overrides the
  // version-upgrade advisory.
  const discoveryEligible = gatewayBacked && capabilities.apiProvider !== "bedrock";
  const discovery = discoveryEligible && resolveDiscovery ? yield* resolveDiscovery() : undefined;
  // A recognized-but-empty gateway catalog is NOT treated as authoritative:
  // wiping the whole model list on a transient/misconfigured empty response is
  // worse than keeping the built-in/manual list. Only a non-empty catalog is
  // authoritative; empty and failed responses both degrade to the fallback list
  // with a warning.
  const discoveredModels = discovery?.kind === "discovered" ? discovery.models : [];
  const discoverySucceeded = discoveredModels.length > 0;
  const readyModels = buildClaudeModels(versionBuiltIns, discoveredModels, discoverySucceeded);
  const discoveryWarning =
    discovery?.kind === "failed"
      ? `Model discovery from the configured Claude gateway (${discovery.host}) failed; using the built-in and manually configured model list.`
      : discovery?.kind === "discovered" && discovery.models.length === 0
        ? "The configured Claude gateway returned no models; using the built-in and manually configured model list."
        : undefined;
  const readyStatus = discoveryWarning ? "warning" : "ready";
  // Keep the first-party version-upgrade advisory even when a gateway catalog is
  // authoritative: the gateway may proxy a real Claude model whose built-in
  // capabilities the local CLI is too old to drive. Join with any discovery
  // warning.
  const readyMessage =
    [versionUpgradeMessage, discoveryWarning].filter((part) => Boolean(part)).join(" ") ||
    undefined;

  return buildServerProvider({
    presentation: CLAUDE_PRESENTATION,
    enabled: claudeSettings.enabled,
    checkedAt,
    models: readyModels,
    slashCommands: dedupedSlashCommands,
    probe: {
      installed: true,
      version: parsedVersion,
      status: readyStatus,
      auth: {
        status: "authenticated",
        ...(capabilities.email ? { email: capabilities.email } : {}),
        ...(authMetadata ? authMetadata : {}),
      },
      ...(readyMessage ? { message: readyMessage } : {}),
    },
  });
});

const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

export const makePendingClaudeProvider = (
  claudeSettings: ClaudeSettings,
  environment?: NodeJS.ProcessEnv,
): Effect.Effect<ServerProviderDraft> =>
  Effect.gen(function* () {
    const checkedAt = yield* nowIso;
    const gatewayBacked =
      resolveClaudeModelsEndpoint((environment ?? process.env).ANTHROPIC_BASE_URL) !== null;
    // A gateway instance's catalog is authoritative once discovered; don't flash
    // the static built-in Claude list before the first refresh completes. Treat
    // it as authoritative-but-empty here so only manual custom models show until
    // discovery runs. Non-gateway instances show the built-in catalog.
    const models = mergeClaudeModelsWithDiscovery({
      builtInModels: BUILT_IN_MODELS,
      discoveredModels: [],
      customModels: claudeSettings.customModels,
      gatewayBacked,
      discoverySucceeded: gatewayBacked,
    });

    if (!claudeSettings.enabled) {
      return buildServerProvider({
        presentation: CLAUDE_PRESENTATION,
        enabled: false,
        checkedAt,
        models,
        probe: {
          installed: false,
          version: null,
          status: "warning",
          auth: { status: "unknown" },
          message: "Claude is disabled in T3 Code settings.",
        },
      });
    }

    return buildServerProvider({
      presentation: CLAUDE_PRESENTATION,
      enabled: true,
      checkedAt,
      models,
      probe: {
        installed: false,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: "Claude provider status has not been checked in this session yet.",
      },
    });
  });

export { probeClaudeCapabilities };
