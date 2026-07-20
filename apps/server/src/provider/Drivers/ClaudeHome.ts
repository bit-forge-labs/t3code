import * as NodeOS from "node:os";

import type { ClaudeSettings } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { expandHomePath } from "../../pathExpansion.ts";

/**
 * Env vars that a Claude Code `settings.json` `env` block may define to point
 * the CLI at a custom gateway. T3's model discovery and provider-usage lookups
 * need to see these even though they are configured for the CLI, not for T3's
 * own process env.
 *
 * `CLIPROXY_MANAGEMENT_KEY` is T3-specific: it authenticates the optional
 * CLIProxyAPI Management API call that surfaces per-provider usage limits. It is
 * ignored by Claude Code itself but read here from the same `env` block for
 * configuration parity with the gateway settings.
 */
const DISCOVERY_RELEVANT_ENV_KEYS = [
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_API_KEY",
  "CLIPROXY_MANAGEMENT_KEY",
] as const;

function extractAnthropicEnvOverlay(raw: string): Record<string, string> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  if (!parsed || typeof parsed !== "object") return {};
  const env = (parsed as { readonly env?: unknown }).env;
  if (!env || typeof env !== "object") return {};
  const record = env as Record<string, unknown>;
  const overlay: Record<string, string> = {};
  for (const key of DISCOVERY_RELEVANT_ENV_KEYS) {
    const value = record[key];
    if (typeof value === "string" && value.trim().length > 0) {
      overlay[key] = value;
    }
  }
  return overlay;
}

/**
 * Read the Anthropic gateway env (`ANTHROPIC_BASE_URL` / `ANTHROPIC_AUTH_TOKEN`
 * / `ANTHROPIC_API_KEY`) from a Claude Code config directory's `settings.json`
 * and `settings.local.json` `env` blocks, so an instance configured the
 * Claude-Code way (a `CLAUDE_CONFIG_DIR` file rather than T3's own per-instance
 * environment) is still discoverable. `settings.local.json` overrides
 * `settings.json`. Missing or malformed files are ignored.
 *
 * The result is an *overlay* — the caller merges it under the real process env
 * so explicit T3 / OS env always wins.
 */
export const readClaudeConfigDirAnthropicEnv = Effect.fn("readClaudeConfigDirAnthropicEnv")(
  function* (
    config: Pick<ClaudeSettings, "homePath">,
  ): Effect.fn.Return<Record<string, string>, never, Path.Path | FileSystem.FileSystem> {
    const path = yield* Path.Path;
    const fileSystem = yield* FileSystem.FileSystem;
    const resolvedHomePath = yield* resolveClaudeHomePath(config);

    const overlay: Record<string, string> = {};
    // settings.json first, then settings.local.json (local overrides).
    for (const fileName of ["settings.json", "settings.local.json"] as const) {
      const filePath = path.join(resolvedHomePath, fileName);
      const contents = yield* fileSystem
        .readFileString(filePath)
        .pipe(Effect.orElseSucceed(() => undefined));
      if (contents !== undefined) {
        Object.assign(overlay, extractAnthropicEnvOverlay(contents));
      }
    }
    return overlay;
  },
);

/**
 * Merge a config-dir Anthropic env overlay under a base env: keys already
 * present (non-empty) in the base env win, so explicit T3 / OS environment is
 * never overridden by a `settings.json` value.
 */
export function mergeClaudeDiscoveryEnvironment(
  baseEnv: NodeJS.ProcessEnv,
  overlay: Record<string, string>,
): NodeJS.ProcessEnv {
  if (Object.keys(overlay).length === 0) return baseEnv;
  const next: NodeJS.ProcessEnv = { ...baseEnv };
  for (const [key, value] of Object.entries(overlay)) {
    const existing = next[key]?.trim();
    if (!existing) {
      next[key] = value;
    }
  }
  return next;
}

export const resolveClaudeHomePath = Effect.fn("resolveClaudeHomePath")(function* (
  config: Pick<ClaudeSettings, "homePath">,
): Effect.fn.Return<string, never, Path.Path> {
  const path = yield* Path.Path;
  const homePath = config.homePath.trim();
  return path.resolve(homePath.length > 0 ? expandHomePath(homePath) : NodeOS.homedir());
});

export const makeClaudeEnvironment = Effect.fn("makeClaudeEnvironment")(function* (
  config: Pick<ClaudeSettings, "homePath">,
  baseEnv?: NodeJS.ProcessEnv,
): Effect.fn.Return<NodeJS.ProcessEnv, never, Path.Path> {
  const resolvedBaseEnv = baseEnv ?? process.env;
  const homePath = config.homePath.trim();
  if (homePath.length === 0) return resolvedBaseEnv;
  const resolvedHomePath = yield* resolveClaudeHomePath(config);
  return {
    ...resolvedBaseEnv,
    // Isolate this instance's config via CLAUDE_CONFIG_DIR rather than HOME.
    // Overriding HOME also relocates the macOS login keychain lookup
    // ($HOME/Library/Keychains), so the spawned CLI can't find its stored
    // OAuth credentials and reports "Not logged in". CLAUDE_CONFIG_DIR points
    // Claude Code at its config dir directly while leaving HOME (and the
    // keychain) intact.
    CLAUDE_CONFIG_DIR: resolvedHomePath,
  };
});

export const makeClaudeContinuationGroupKey = Effect.fn("makeClaudeContinuationGroupKey")(
  function* (config: Pick<ClaudeSettings, "homePath">): Effect.fn.Return<string, never, Path.Path> {
    const resolvedHomePath = yield* resolveClaudeHomePath(config);
    return `claude:home:${resolvedHomePath}`;
  },
);

export const makeClaudeCapabilitiesCacheKey = Effect.fn("makeClaudeCapabilitiesCacheKey")(
  function* (
    config: Pick<ClaudeSettings, "binaryPath" | "homePath">,
    cwd?: string,
  ): Effect.fn.Return<string, never, Path.Path> {
    const resolvedHomePath = yield* resolveClaudeHomePath(config);
    return `${config.binaryPath}\0${resolvedHomePath}\0${cwd ?? ""}`;
  },
);
