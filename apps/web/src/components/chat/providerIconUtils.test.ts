import { ProviderDriverKind } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { ClaudeAI, CursorIcon, Gemini, GrokIcon, OpenAI } from "../Icons";
import { resolveModelServiceIcon } from "./providerIconUtils";

const claudeAgent = ProviderDriverKind.make("claudeAgent");
const cursor = ProviderDriverKind.make("cursor");

describe("resolveModelServiceIcon", () => {
  it("attributes OpenAI models to the OpenAI icon regardless of driver", () => {
    for (const slug of ["gpt-5.4", "gpt-4o", "chatgpt-4o-latest", "o3-mini", "codex-mini"]) {
      expect(resolveModelServiceIcon({ slug, driverKind: claudeAgent })).toBe(OpenAI);
    }
  });

  it("attributes Anthropic, Google, and xAI models to their brand icons", () => {
    expect(resolveModelServiceIcon({ slug: "claude-opus-4-8", driverKind: cursor })).toBe(ClaudeAI);
    expect(resolveModelServiceIcon({ slug: "gemini-3.5-flash", driverKind: claudeAgent })).toBe(
      Gemini,
    );
    expect(resolveModelServiceIcon({ slug: "grok-build", driverKind: claudeAgent })).toBe(GrokIcon);
  });

  it("recognizes a vendor prefix and subProvider tag", () => {
    expect(resolveModelServiceIcon({ slug: "openai/gpt-5", driverKind: cursor })).toBe(OpenAI);
    expect(
      resolveModelServiceIcon({ slug: "some-model", subProvider: "anthropic", driverKind: cursor }),
    ).toBe(ClaudeAI);
  });

  it("does not misclassify look-alike tokens", () => {
    // `opus` must not match the o1–o4 OpenAI series.
    expect(resolveModelServiceIcon({ slug: "claude-opus-4-8", driverKind: cursor })).toBe(ClaudeAI);
  });

  it("falls back to the provider driver icon for unknown vendors", () => {
    expect(resolveModelServiceIcon({ slug: "command-r-plus", driverKind: cursor })).toBe(
      CursorIcon,
    );
  });

  it("returns null when the driver has no icon and the brand is unknown", () => {
    expect(
      resolveModelServiceIcon({
        slug: "mystery-model",
        driverKind: ProviderDriverKind.make("unknownDriver"),
      }),
    ).toBeNull();
  });
});
