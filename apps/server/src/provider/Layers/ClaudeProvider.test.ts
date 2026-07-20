import { describe, it, assert } from "@effect/vitest";

import type { ClaudeDiscoveredModel, ClaudeModelDiscoveryOutcome } from "./ClaudeModelDiscovery.ts";
import { resolveClaudeModelCapabilitiesForInstance } from "./ClaudeProvider.ts";

const discovery = (
  models: ReadonlyArray<ClaudeDiscoveredModel>,
  tier: "expanded" | "standard" = "expanded",
): ClaudeModelDiscoveryOutcome => ({ kind: "discovered", tier, models });

const builtInCaps = (model: string) =>
  resolveClaudeModelCapabilitiesForInstance({ model, discovery: undefined, gatewayBacked: false });

const effortOptions = (
  caps: ReturnType<typeof resolveClaudeModelCapabilitiesForInstance>,
): ReadonlyArray<string> => {
  const descriptor = caps.optionDescriptors?.find((candidate) => candidate.id === "effort");
  return descriptor?.type === "select" ? descriptor.options.map((option) => option.id) : [];
};

describe("resolveClaudeModelCapabilitiesForInstance", () => {
  it("takes the gateway's context window for a built-in slug", () => {
    // Regression: a proxied built-in used to short-circuit to its static caps,
    // dropping the discovered window and leaving the context meter on the
    // hardcoded 200k default while settings rendered the gateway's 1m.
    const caps = resolveClaudeModelCapabilitiesForInstance({
      model: "claude-opus-4-8",
      discovery: discovery([
        {
          slug: "claude-opus-4-8",
          name: "Claude Opus 4.8",
          contextWindowTokens: 1_000_000,
          maxContextWindowTokens: 1_000_000,
        },
      ]),
      gatewayBacked: true,
    });

    assert.strictEqual(caps.contextWindowTokens, 1_000_000);
    assert.strictEqual(caps.maxContextWindowTokens, 1_000_000);
  });

  it("keeps built-in effort options even when the gateway advertises its own", () => {
    // Regression: merging the catalog's effort descriptor into runtime caps
    // dropped `ultracode`/`ultrathink`, so a stored selection resolved to
    // nothing and silently fell back to the gateway's default reasoning level.
    const caps = resolveClaudeModelCapabilitiesForInstance({
      model: "claude-opus-4-8",
      discovery: discovery([
        {
          slug: "claude-opus-4-8",
          name: "Claude Opus 4.8",
          contextWindowTokens: 1_000_000,
          effortLevels: [
            { value: "low" },
            { value: "medium", isDefault: true },
            { value: "high" },
            { value: "xhigh" },
            { value: "max" },
          ],
        },
      ]),
      gatewayBacked: true,
    });

    const options = effortOptions(caps);
    assert.deepStrictEqual(options, effortOptions(builtInCaps("claude-opus-4-8")));
    assert.include(options, "ultracode");
    assert.include(options, "ultrathink");
  });

  it("preserves the full built-in descriptor set when merging discovery", () => {
    const merged = resolveClaudeModelCapabilitiesForInstance({
      model: "claude-opus-4-8",
      discovery: discovery([
        { slug: "claude-opus-4-8", name: "Claude Opus 4.8", contextWindowTokens: 1_000_000 },
      ]),
      gatewayBacked: true,
    });

    assert.deepStrictEqual(
      merged.optionDescriptors,
      builtInCaps("claude-opus-4-8").optionDescriptors,
    );
  });

  it("leaves a built-in untouched when the gateway advertises no context data", () => {
    const caps = resolveClaudeModelCapabilitiesForInstance({
      model: "claude-opus-4-8",
      // Standard `/v1/models` tier carries slug + name only.
      discovery: discovery([{ slug: "claude-opus-4-8", name: "Claude Opus 4.8" }], "standard"),
      gatewayBacked: true,
    });

    assert.strictEqual(caps.contextWindowTokens, undefined);
    assert.deepStrictEqual(
      caps.optionDescriptors,
      builtInCaps("claude-opus-4-8").optionDescriptors,
    );
  });

  it("ignores a discovered model whose slug does not match", () => {
    const caps = resolveClaudeModelCapabilitiesForInstance({
      model: "claude-opus-4-8",
      discovery: discovery([
        { slug: "claude-sonnet-5", name: "Claude Sonnet 5", contextWindowTokens: 1_000_000 },
      ]),
      gatewayBacked: true,
    });

    assert.strictEqual(caps.contextWindowTokens, undefined);
  });

  it("still builds caps for a discovered non-built-in slug", () => {
    const caps = resolveClaudeModelCapabilitiesForInstance({
      model: "gpt-5.6-sol",
      discovery: discovery([
        { slug: "gpt-5.6-sol", name: "GPT 5.6 Sol", contextWindowTokens: 400_000 },
      ]),
      gatewayBacked: true,
    });

    assert.strictEqual(caps.contextWindowTokens, 400_000);
  });
});
