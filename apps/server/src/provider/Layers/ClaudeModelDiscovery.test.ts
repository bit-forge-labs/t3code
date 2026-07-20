import { describe, it, assert } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";

import {
  discoverClaudeGatewayModels,
  isFirstPartyAnthropicHost,
  parseClaudeDiscoveryPayload,
  resolveClaudeModelsEndpoint,
} from "./ClaudeModelDiscovery.ts";

// ── Mock HttpClient ─────────────────────────────────────────────────

interface MockResponse {
  readonly status?: number;
  readonly body?: unknown;
  /** Return a non-JSON body to exercise decode failures. */
  readonly rawText?: string;
}

function mockDiscoveryClient(
  responder: (input: { readonly url: string; readonly headers: Headers }) => MockResponse,
) {
  const calls: Array<{ readonly url: string; readonly headers: Headers }> = [];
  const layer = HttpClient.make((request) => {
    const headers = new Headers(request.headers as unknown as Record<string, string>);
    calls.push({ url: request.url, headers });
    const result = responder({ url: request.url, headers });
    const status = result.status ?? 200;
    const response =
      result.rawText !== undefined
        ? new Response(result.rawText, { status })
        : Response.json(result.body ?? {}, { status });
    return Effect.succeed(HttpClientResponse.fromWeb(request, response));
  });
  return { layer, calls };
}

const run = <A>(
  effect: Effect.Effect<A, never, HttpClient.HttpClient>,
  client: HttpClient.HttpClient,
) => Effect.provideService(effect, HttpClient.HttpClient, client);

// ── Pure: endpoint resolution ───────────────────────────────────────

describe("resolveClaudeModelsEndpoint", () => {
  it("appends /v1/models to a bare gateway base URL", () => {
    assert.deepStrictEqual(resolveClaudeModelsEndpoint("http://localhost:8317"), {
      modelsUrl: "http://localhost:8317/v1/models",
      host: "localhost:8317",
    });
  });

  it("does not duplicate /v1 when the base already ends in it", () => {
    assert.strictEqual(
      resolveClaudeModelsEndpoint("http://localhost:8317/v1")?.modelsUrl,
      "http://localhost:8317/v1/models",
    );
  });

  it("preserves a gateway path prefix", () => {
    assert.strictEqual(
      resolveClaudeModelsEndpoint("https://gw.example.com/anthropic")?.modelsUrl,
      "https://gw.example.com/anthropic/v1/models",
    );
  });

  it("drops query and fragment", () => {
    assert.strictEqual(
      resolveClaudeModelsEndpoint("http://localhost:8317/v1?foo=bar#frag")?.modelsUrl,
      "http://localhost:8317/v1/models",
    );
  });

  it("returns null for absent, blank, malformed, or non-HTTP URLs", () => {
    assert.strictEqual(resolveClaudeModelsEndpoint(undefined), null);
    assert.strictEqual(resolveClaudeModelsEndpoint("   "), null);
    assert.strictEqual(resolveClaudeModelsEndpoint("not a url"), null);
    assert.strictEqual(resolveClaudeModelsEndpoint("ftp://host/v1"), null);
  });

  it("skips first-party Anthropic hosts", () => {
    assert.strictEqual(resolveClaudeModelsEndpoint("https://api.anthropic.com"), null);
    assert.strictEqual(isFirstPartyAnthropicHost("api.anthropic.com"), true);
    assert.strictEqual(isFirstPartyAnthropicHost("gw.example.com"), false);
  });
});

// ── Pure: payload parsing ───────────────────────────────────────────

describe("parseClaudeDiscoveryPayload", () => {
  it("maps an expanded catalog with context and reasoning levels", () => {
    const parsed = parseClaudeDiscoveryPayload({
      models: [
        {
          slug: "gpt-5.4",
          display_name: "GPT-5.4",
          description: "A capable model.",
          context_window: 272_000,
          max_context_window: 400_000,
          supported_reasoning_levels: [
            { effort: "low", description: "Fast" },
            { effort: "high", description: "Deep" },
          ],
          default_reasoning_level: "high",
        },
      ],
    });
    assert.strictEqual(parsed?.tier, "expanded");
    assert.deepStrictEqual(parsed?.models, [
      {
        slug: "gpt-5.4",
        name: "GPT-5.4",
        description: "A capable model.",
        contextWindowTokens: 272_000,
        maxContextWindowTokens: 400_000,
        effortLevels: [
          { value: "low", description: "Fast" },
          { value: "high", description: "Deep", isDefault: true },
        ],
      },
    ]);
  });

  it("falls back to slug for a missing display name and omits absent fields", () => {
    const parsed = parseClaudeDiscoveryPayload({ models: [{ slug: "m1" }] });
    assert.deepStrictEqual(parsed?.models, [{ slug: "m1", name: "m1" }]);
  });

  it("detects the standard envelope and maps id-only entries", () => {
    const parsed = parseClaudeDiscoveryPayload({
      object: "list",
      data: [{ id: "gpt-5.4", object: "model" }],
    });
    assert.strictEqual(parsed?.tier, "standard");
    assert.deepStrictEqual(parsed?.models, [{ slug: "gpt-5.4", name: "gpt-5.4" }]);
  });

  it("discards invalid entries and de-duplicates by slug", () => {
    const parsed = parseClaudeDiscoveryPayload({
      models: [
        { slug: "keep" },
        { slug: "   " },
        { display_name: "no slug" },
        42,
        { slug: "keep", display_name: "dup" },
      ],
    });
    assert.deepStrictEqual(parsed?.models, [{ slug: "keep", name: "keep" }]);
  });

  it("returns null for an unrecognized envelope", () => {
    assert.strictEqual(parseClaudeDiscoveryPayload({ foo: "bar" }), null);
    assert.strictEqual(parseClaudeDiscoveryPayload(null), null);
    assert.strictEqual(parseClaudeDiscoveryPayload("nope"), null);
  });

  it("ignores a default reasoning level absent from the supported list", () => {
    const parsed = parseClaudeDiscoveryPayload({
      models: [
        {
          slug: "m",
          supported_reasoning_levels: [{ effort: "low" }],
          default_reasoning_level: "high",
        },
      ],
    });
    assert.deepStrictEqual(parsed?.models[0]?.effortLevels, [{ value: "low" }]);
  });
});

// ── HTTP discovery ──────────────────────────────────────────────────

describe("discoverClaudeGatewayModels", () => {
  it("returns ineligible without a custom base URL", () =>
    Effect.gen(function* () {
      const { layer, calls } = mockDiscoveryClient(() => ({ body: {} }));
      const outcome = yield* run(
        discoverClaudeGatewayModels({ environment: {}, clientVersion: null }),
        layer,
      );
      assert.strictEqual(outcome.kind, "ineligible");
      assert.strictEqual(calls.length, 0);
    }).pipe(Effect.runPromise));

  it("requests the expanded catalog first with a client_version parameter", () =>
    Effect.gen(function* () {
      const { layer, calls } = mockDiscoveryClient(() => ({
        body: { models: [{ slug: "gpt-5.4", display_name: "GPT-5.4" }] },
      }));
      const outcome = yield* run(
        discoverClaudeGatewayModels({
          environment: { ANTHROPIC_BASE_URL: "http://localhost:8317" },
          clientVersion: "2.1.170",
        }),
        layer,
      );
      assert.strictEqual(outcome.kind, "discovered");
      if (outcome.kind === "discovered") {
        assert.strictEqual(outcome.tier, "expanded");
        assert.strictEqual(outcome.models[0]?.slug, "gpt-5.4");
      }
      // Exactly one request; it carried the client_version trigger.
      assert.strictEqual(calls.length, 1);
      assert.ok(calls[0]?.url.includes("client_version=2.1.170"));
    }).pipe(Effect.runPromise));

  it("accepts a standard response to the expanded request without a second call", () =>
    Effect.gen(function* () {
      const { layer, calls } = mockDiscoveryClient(() => ({
        body: { object: "list", data: [{ id: "gpt-5.4" }] },
      }));
      const outcome = yield* run(
        discoverClaudeGatewayModels({
          environment: { ANTHROPIC_BASE_URL: "http://localhost:8317" },
          clientVersion: null,
        }),
        layer,
      );
      assert.strictEqual(outcome.kind, "discovered");
      if (outcome.kind === "discovered") {
        assert.strictEqual(outcome.tier, "standard");
      }
      assert.strictEqual(calls.length, 1);
    }).pipe(Effect.runPromise));

  it("falls back to the plain endpoint when the expanded request is rejected", () =>
    Effect.gen(function* () {
      const { layer, calls } = mockDiscoveryClient(({ url }) =>
        url.includes("client_version")
          ? { status: 400, body: { error: "bad" } }
          : { body: { object: "list", data: [{ id: "gpt-5.4" }] } },
      );
      const outcome = yield* run(
        discoverClaudeGatewayModels({
          environment: { ANTHROPIC_BASE_URL: "http://localhost:8317" },
          clientVersion: null,
        }),
        layer,
      );
      assert.strictEqual(outcome.kind, "discovered");
      if (outcome.kind === "discovered") {
        assert.strictEqual(outcome.tier, "standard");
        assert.strictEqual(outcome.models[0]?.slug, "gpt-5.4");
      }
      assert.strictEqual(calls.length, 2);
    }).pipe(Effect.runPromise));

  it("falls back when the expanded response is unrecognized JSON", () =>
    Effect.gen(function* () {
      const { layer, calls } = mockDiscoveryClient(({ url }) =>
        url.includes("client_version")
          ? { body: { unexpected: true } }
          : { body: { models: [{ slug: "m1" }] } },
      );
      const outcome = yield* run(
        discoverClaudeGatewayModels({
          environment: { ANTHROPIC_BASE_URL: "http://localhost:8317" },
          clientVersion: null,
        }),
        layer,
      );
      assert.strictEqual(outcome.kind, "discovered");
      assert.strictEqual(calls.length, 2);
    }).pipe(Effect.runPromise));

  it("reports failure when both attempts fail", () =>
    Effect.gen(function* () {
      const { layer } = mockDiscoveryClient(() => ({ status: 500, body: {} }));
      const outcome = yield* run(
        discoverClaudeGatewayModels({
          environment: { ANTHROPIC_BASE_URL: "http://localhost:8317" },
          clientVersion: null,
        }),
        layer,
      );
      assert.strictEqual(outcome.kind, "failed");
      if (outcome.kind === "failed") {
        assert.strictEqual(outcome.host, "localhost:8317");
      }
    }).pipe(Effect.runPromise));

  it("sends the auth token as a bearer and never an api key alongside it", () =>
    Effect.gen(function* () {
      const { layer, calls } = mockDiscoveryClient(() => ({ body: { models: [] } }));
      yield* run(
        discoverClaudeGatewayModels({
          environment: {
            ANTHROPIC_BASE_URL: "http://localhost:8317",
            ANTHROPIC_AUTH_TOKEN: "tok-123",
            ANTHROPIC_API_KEY: "key-456",
          },
          clientVersion: null,
        }),
        layer,
      );
      assert.strictEqual(calls[0]?.headers.get("authorization"), "Bearer tok-123");
      assert.strictEqual(calls[0]?.headers.get("x-api-key"), null);
    }).pipe(Effect.runPromise));

  it("uses the api key as x-api-key when no auth token is present", () =>
    Effect.gen(function* () {
      const { layer, calls } = mockDiscoveryClient(() => ({ body: { models: [] } }));
      yield* run(
        discoverClaudeGatewayModels({
          environment: {
            ANTHROPIC_BASE_URL: "http://localhost:8317",
            ANTHROPIC_API_KEY: "key-456",
          },
          clientVersion: null,
        }),
        layer,
      );
      assert.strictEqual(calls[0]?.headers.get("x-api-key"), "key-456");
      assert.strictEqual(calls[0]?.headers.get("authorization"), null);
    }).pipe(Effect.runPromise));
});
