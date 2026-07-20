import { ProviderDriverKind } from "@t3tools/contracts";
import { ClaudeAI, CursorIcon, Gemini, GrokIcon, Icon, OpenAI, OpenCodeIcon } from "../Icons";
import { PROVIDER_OPTIONS } from "../../session-logic";

export const PROVIDER_ICON_BY_PROVIDER: Partial<Record<ProviderDriverKind, Icon>> = {
  [ProviderDriverKind.make("codex")]: OpenAI,
  [ProviderDriverKind.make("claudeAgent")]: ClaudeAI,
  [ProviderDriverKind.make("opencode")]: OpenCodeIcon,
  [ProviderDriverKind.make("cursor")]: CursorIcon,
  [ProviderDriverKind.make("grok")]: GrokIcon,
};

/**
 * Per-model service-brand matchers. A model's icon should reflect the upstream
 * service (OpenAI for `gpt-*`, Google for `gemini-*`, …), not the provider
 * driver it happens to be routed through. This matters for aggregating
 * providers — a Claude instance pointed at a gateway (CLIProxyAPI), Cursor, or
 * OpenCode — where a single instance serves models from many vendors.
 *
 * Each token must sit on a boundary (start, or after `/ . _ -` / whitespace) so
 * `opus` never matches the `o1`–`o4` OpenAI series and `command` never matches
 * a substring. Order matters: the first matching brand wins.
 */
const MODEL_BRAND_ICON_MATCHERS: ReadonlyArray<{ readonly icon: Icon; readonly test: RegExp }> = [
  { icon: ClaudeAI, test: /(?:^|[/\s._-])(?:claude|anthropic)/u },
  {
    icon: OpenAI,
    test: /(?:^|[/\s._-])(?:gpt|chatgpt|openai|codex|o[1-4](?![a-z])|dall-?e|davinci)/u,
  },
  { icon: Gemini, test: /(?:^|[/\s._-])(?:gemini|gemma|palm|bison|google)/u },
  { icon: GrokIcon, test: /(?:^|[/\s._-])(?:grok|x-?ai)/u },
];

/**
 * Resolve the icon for a model row. Prefers the model's own service brand
 * (inferred from its `subProvider` vendor tag and slug), falling back to the
 * provider driver's icon when the brand can't be identified.
 */
export function resolveModelServiceIcon(input: {
  readonly slug: string;
  readonly subProvider?: string | undefined;
  readonly driverKind: ProviderDriverKind;
}): Icon | null {
  const haystack = `${input.subProvider ?? ""} ${input.slug}`.toLowerCase();
  for (const { icon, test } of MODEL_BRAND_ICON_MATCHERS) {
    if (test.test(haystack)) {
      return icon;
    }
  }
  return PROVIDER_ICON_BY_PROVIDER[input.driverKind] ?? null;
}

function isAvailableProviderOption(option: (typeof PROVIDER_OPTIONS)[number]): option is {
  value: ProviderDriverKind;
  label: string;
  available: true;
  pickerSidebarBadge?: "new" | "soon";
} {
  return option.available;
}

export const AVAILABLE_PROVIDER_OPTIONS = PROVIDER_OPTIONS.filter(isAvailableProviderOption);

export type ModelEsque = {
  slug: string;
  name: string;
  shortName?: string | undefined;
  subProvider?: string | undefined;
};

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function stripLeadingQualifier(value: string, qualifier: string | null | undefined): string {
  const trimmedQualifier = qualifier?.trim();
  if (!trimmedQualifier) {
    return value;
  }

  const pattern = new RegExp(`^${escapeRegExp(trimmedQualifier)}(?:\\s*[.:/-]\\s*|\\s+)`, "iu");
  return value.replace(pattern, "").trim() || value;
}

export function getDisplayModelName(
  model: ModelEsque,
  options?: { preferShortName?: boolean },
): string {
  const name = options?.preferShortName && model.shortName ? model.shortName : model.name;
  return stripLeadingQualifier(name, model.subProvider);
}

export function getTriggerDisplayModelName(model: ModelEsque): string {
  return getDisplayModelName(model, { preferShortName: true });
}

export function getTriggerDisplayModelLabel(model: ModelEsque): string {
  return getTriggerDisplayModelName(model);
}
