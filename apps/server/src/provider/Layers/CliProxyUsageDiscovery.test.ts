import { describe, it, assert } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";

import {
  fetchCliProxyProviderUsage,
  isClaudeAccount,
  isCodexAccount,
  parseApiCallUsageBody,
  parseAuthFilesCredentials,
  parseClaudeQuotaWindows,
  parseCodexQuotaWindows,
  resolveCliProxyManagementEndpoint,
} from "./CliProxyUsageDiscovery.ts";

// ── Mock HttpClient ─────────────────────────────────────────────────

interface MockResponse {
  readonly status?: number;
  readonly body?: unknown;
  readonly rawText?: string;
}

interface MockCall {
  readonly url: string;
  readonly method: string;
  readonly headers: Headers;
}

function mockUsageClient(responder: (input: MockCall) => MockResponse) {
  const calls: Array<MockCall> = [];
  const layer = HttpClient.make((request) => {
    const headers = new Headers(request.headers as unknown as Record<string, string>);
    const call: MockCall = { url: request.url, method: request.method, headers };
    calls.push(call);
    const result = responder(call);
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

const claudeEnv = {
  ANTHROPIC_BASE_URL: "http://localhost:8317",
  CLIPROXY_MANAGEMENT_KEY: "secret",
} as const;

const usageBody = JSON.stringify({
  five_hour: { utilization: 48.0, resets_at: "2026-07-20T18:49:59.308595+00:00" },
  seven_day: { utilization: 50.0, resets_at: "2026-07-25T10:00:00.000+00:00" },
  limits: [
    {
      kind: "weekly_scoped",
      percent: 52,
      resets_at: "2026-07-25T10:00:00.000+00:00",
      scope: { model: { display_name: "Fable" } },
    },
  ],
});

// ── Pure: endpoint resolution ───────────────────────────────────────

describe("resolveCliProxyManagementEndpoint", () => {
  it("derives the management base from a bare gateway base URL", () => {
    assert.deepStrictEqual(resolveCliProxyManagementEndpoint("http://localhost:8317"), {
      managementBaseUrl: "http://localhost:8317/v0/management",
      host: "localhost:8317",
    });
  });

  it("strips a trailing /v1 proxy segment before appending the management path", () => {
    assert.strictEqual(
      resolveCliProxyManagementEndpoint("http://localhost:8317/v1")?.managementBaseUrl,
      "http://localhost:8317/v0/management",
    );
  });

  it("strips a trailing /v1 while preserving a reverse-proxy prefix", () => {
    // The management API is a sibling of /v1 under the same mount, so the prefix
    // must be kept for a reverse-proxied gateway.
    assert.strictEqual(
      resolveCliProxyManagementEndpoint("https://gw.example.com/anthropic/v1")?.managementBaseUrl,
      "https://gw.example.com/anthropic/v0/management",
    );
  });

  it("drops query and fragment", () => {
    assert.strictEqual(
      resolveCliProxyManagementEndpoint("http://localhost:8317/v1?foo=bar#frag")?.managementBaseUrl,
      "http://localhost:8317/v0/management",
    );
  });

  it("returns null for absent, blank, malformed, or non-HTTP URLs", () => {
    assert.strictEqual(resolveCliProxyManagementEndpoint(undefined), null);
    assert.strictEqual(resolveCliProxyManagementEndpoint("   "), null);
    assert.strictEqual(resolveCliProxyManagementEndpoint("not a url"), null);
    assert.strictEqual(resolveCliProxyManagementEndpoint("ftp://host/v1"), null);
  });

  it("skips first-party Anthropic hosts", () => {
    assert.strictEqual(resolveCliProxyManagementEndpoint("https://api.anthropic.com"), null);
  });
});

// ── Pure: auth-files parsing (per account) ──────────────────────────

describe("parseAuthFilesCredentials", () => {
  it("maps one record per credential with auth_index, label, status, and counts", () => {
    const parsed = parseAuthFilesCredentials({
      files: [
        {
          provider: "claude",
          auth_index: "idx1",
          email: "user@example.com",
          status: "ready",
          success: 12,
          failed: 1,
        },
      ],
    });
    assert.deepStrictEqual(parsed, [
      {
        provider: "claude",
        authIndex: "idx1",
        label: "user@example.com",
        status: "ready",
        successCount: 12,
        failedCount: 1,
      },
    ]);
  });

  it("does NOT aggregate multiple credentials of one provider", () => {
    const parsed = parseAuthFilesCredentials({
      files: [
        { provider: "openai", status: "ready" },
        { provider: "openai", status: "cooldown" },
      ],
    });
    assert.strictEqual(parsed?.length, 2);
  });

  it("folds disabled/unavailable flags into status ahead of the status string", () => {
    const parsed = parseAuthFilesCredentials({
      files: [
        { provider: "a", status: "ready", disabled: true },
        { provider: "b", status: "ready", unavailable: true },
      ],
    });
    assert.strictEqual(parsed?.[0]?.status, "disabled");
    assert.strictEqual(parsed?.[1]?.status, "cooldown");
  });

  it("derives a generic usage percentage from a used/limit pair", () => {
    const parsed = parseAuthFilesCredentials({
      files: [{ provider: "gemini", status: "ready", used: 30, limit: 120 }],
    });
    assert.strictEqual(parsed?.[0]?.usedPercentage, 25);
  });

  it("extracts a ChatGPT account id from a nested object", () => {
    const parsed = parseAuthFilesCredentials({
      files: [
        {
          provider: "codex",
          auth_index: "cx1",
          status: "ready",
          account: { account_id: "acct-nested" },
        },
      ],
    });
    assert.strictEqual(parsed?.[0]?.accountId, "acct-nested");
  });

  it("skips entries without a provider", () => {
    const parsed = parseAuthFilesCredentials({
      files: [{ status: "ready" }, { provider: "   " }, { provider: "kimi", status: "ready" }],
    });
    assert.deepStrictEqual(parsed, [{ provider: "kimi", status: "ready" }]);
  });

  it("returns null for an unrecognized envelope, [] for an empty file list", () => {
    assert.strictEqual(parseAuthFilesCredentials({ foo: "bar" }), null);
    assert.strictEqual(parseAuthFilesCredentials(null), null);
    assert.deepStrictEqual(parseAuthFilesCredentials({ files: [] }), []);
  });
});

// ── Pure: /api-call envelope + Claude quota windows ─────────────────

describe("parseApiCallUsageBody", () => {
  it("unwraps a 200 envelope's JSON body string", () => {
    assert.deepStrictEqual(parseApiCallUsageBody({ status_code: 200, body: '{"a":1}' }), { a: 1 });
  });

  it('accepts a stringy status code of "200"', () => {
    assert.deepStrictEqual(parseApiCallUsageBody({ status_code: "200", body: '{"a":1}' }), {
      a: 1,
    });
  });

  it("returns null for a non-200 upstream status, non-string body, or bad JSON", () => {
    assert.strictEqual(parseApiCallUsageBody({ status_code: 403, body: "{}" }), null);
    assert.strictEqual(parseApiCallUsageBody({ status_code: "500", body: "{}" }), null);
    assert.strictEqual(parseApiCallUsageBody({ status_code: 200, body: { a: 1 } }), null);
    assert.strictEqual(parseApiCallUsageBody({ status_code: 200, body: "{" }), null);
    assert.strictEqual(parseApiCallUsageBody("nope"), null);
  });
});

describe("parseClaudeQuotaWindows", () => {
  it("extracts the 5h and 7d windows with utilization and normalized reset times", () => {
    const windows = parseClaudeQuotaWindows({
      five_hour: { utilization: 48.0, resets_at: "2026-07-20T18:49:59.308595+00:00" },
      seven_day: { utilization: 50.0, resets_at: "2026-07-25T10:00:00.000+00:00" },
    });
    assert.deepStrictEqual(windows, [
      { label: "5h", usedPercentage: 48, resetsAt: "2026-07-20T18:49:59.308Z" },
      { label: "7d", usedPercentage: 50, resetsAt: "2026-07-25T10:00:00.000Z" },
    ]);
  });

  it("suffixes duplicate model-scoped labels so they stay unique", () => {
    const windows = parseClaudeQuotaWindows({
      limits: [
        {
          kind: "weekly_scoped",
          percent: 30,
          scope: { model: { display_name: "Fable" }, surface: "a" },
        },
        {
          kind: "weekly_scoped",
          percent: 40,
          scope: { model: { display_name: "Fable" }, surface: "b" },
        },
      ],
    });
    assert.deepStrictEqual(windows, [
      { label: "Fable 7d", usedPercentage: 30 },
      { label: "Fable 7d (2)", usedPercentage: 40 },
    ]);
  });

  it("adds a model-scoped weekly cap from the limits array", () => {
    const windows = parseClaudeQuotaWindows({
      five_hour: { utilization: 10 },
      limits: [
        {
          kind: "weekly_scoped",
          percent: 52,
          resets_at: "2026-07-25T10:00:00.000+00:00",
          scope: { model: { display_name: "Fable" } },
        },
        { kind: "weekly_all", percent: 50 },
      ],
    });
    assert.deepStrictEqual(windows, [
      { label: "5h", usedPercentage: 10 },
      { label: "Fable 7d", usedPercentage: 52, resetsAt: "2026-07-25T10:00:00.000Z" },
    ]);
  });

  it("skips a window with an unreadable utilization and omits a bad reset time", () => {
    const windows = parseClaudeQuotaWindows({
      five_hour: { utilization: null },
      seven_day: { utilization: 12, resets_at: "not-a-date" },
    });
    assert.deepStrictEqual(windows, [{ label: "7d", usedPercentage: 12 }]);
  });

  it("returns [] for a non-object", () => {
    assert.deepStrictEqual(parseClaudeQuotaWindows(null), []);
  });
});

describe("isClaudeAccount / isCodexAccount", () => {
  it("classify providers by family", () => {
    assert.strictEqual(isClaudeAccount("claude"), true);
    assert.strictEqual(isClaudeAccount("Anthropic"), true);
    assert.strictEqual(isClaudeAccount("openai"), false);
    assert.strictEqual(isCodexAccount("codex"), true);
    assert.strictEqual(isCodexAccount("OpenAI"), true);
    assert.strictEqual(isCodexAccount("claude"), false);
  });
});

describe("parseCodexQuotaWindows", () => {
  it("extracts the account-wide window and additional named limits", () => {
    const windows = parseCodexQuotaWindows({
      rate_limit: {
        primary_window: { used_percent: 2, limit_window_seconds: 604800, reset_at: 1785134475 },
        secondary_window: null,
      },
      additional_rate_limits: [
        {
          limit_name: "GPT-5.3-Codex-Spark",
          rate_limit: {
            primary_window: { used_percent: 0, limit_window_seconds: 604800, reset_at: 1785179723 },
          },
        },
      ],
    });
    assert.strictEqual(windows.length, 2);
    assert.strictEqual(windows[0]?.label, "7d");
    assert.strictEqual(windows[0]?.usedPercentage, 2);
    assert.ok(windows[0]?.resetsAt?.startsWith("20"));
    assert.strictEqual(windows[1]?.label, "Spark 7d");
    assert.strictEqual(windows[1]?.usedPercentage, 0);
  });

  it("labels a 5h window and skips null windows", () => {
    const windows = parseCodexQuotaWindows({
      rate_limit: {
        primary_window: { used_percent: 10, limit_window_seconds: 18000 },
        secondary_window: null,
      },
    });
    assert.deepStrictEqual(windows, [{ label: "5h", usedPercentage: 10 }]);
  });

  it("names an additional limit by metered_feature when limit_name is absent, and skips unnamed ones", () => {
    const windows = parseCodexQuotaWindows({
      additional_rate_limits: [
        {
          metered_feature: "codex_bengalfox",
          rate_limit: { primary_window: { used_percent: 3, limit_window_seconds: 604800 } },
        },
        { rate_limit: { primary_window: { used_percent: 9, limit_window_seconds: 604800 } } },
      ],
    });
    assert.deepStrictEqual(windows, [{ label: "codex_bengalfox 7d", usedPercentage: 3 }]);
  });

  it("disambiguates colliding labels with a suffix", () => {
    const windows = parseCodexQuotaWindows({
      rate_limit: {
        primary_window: { used_percent: 1, limit_window_seconds: 604800 },
        secondary_window: { used_percent: 2, limit_window_seconds: 604800 },
      },
    });
    assert.deepStrictEqual(windows, [
      { label: "7d", usedPercentage: 1 },
      { label: "7d (2)", usedPercentage: 2 },
    ]);
  });

  it("returns [] for a non-object", () => {
    assert.deepStrictEqual(parseCodexQuotaWindows(null), []);
  });
});

// ── HTTP usage fetch ────────────────────────────────────────────────

describe("fetchCliProxyProviderUsage", () => {
  it("returns ineligible without a custom base URL", () =>
    Effect.gen(function* () {
      const { layer, calls } = mockUsageClient(() => ({ body: {} }));
      const outcome = yield* run(
        fetchCliProxyProviderUsage({ environment: { CLIPROXY_MANAGEMENT_KEY: "k" } }),
        layer,
      );
      assert.strictEqual(outcome.kind, "ineligible");
      assert.strictEqual(calls.length, 0);
    }).pipe(Effect.runPromise));

  it("returns ineligible when no management key is configured", () =>
    Effect.gen(function* () {
      const { layer, calls } = mockUsageClient(() => ({ body: { files: [] } }));
      const outcome = yield* run(
        fetchCliProxyProviderUsage({
          environment: { ANTHROPIC_BASE_URL: "http://localhost:8317" },
        }),
        layer,
      );
      assert.strictEqual(outcome.kind, "ineligible");
      assert.strictEqual(calls.length, 0);
    }).pipe(Effect.runPromise));

  it("reads Claude quota via a follow-up api-call and returns windows", () =>
    Effect.gen(function* () {
      const { layer, calls } = mockUsageClient(({ url }) =>
        url.endsWith("/auth-files")
          ? {
              body: {
                files: [
                  {
                    provider: "claude",
                    auth_index: "idx1",
                    email: "u@e.com",
                    status: "ready",
                    success: 4,
                    failed: 0,
                  },
                ],
              },
            }
          : url.endsWith("/api-call")
            ? { body: { status_code: 200, header: {}, body: usageBody } }
            : { body: {} },
      );
      const outcome = yield* run(fetchCliProxyProviderUsage({ environment: claudeEnv }), layer);

      assert.strictEqual(outcome.kind, "available");
      if (outcome.kind === "available") {
        const entry = outcome.providers[0];
        assert.strictEqual(entry?.provider, "claude");
        assert.strictEqual(entry?.label, "u@e.com");
        assert.deepStrictEqual(entry?.quotaWindows, [
          { label: "5h", usedPercentage: 48, resetsAt: "2026-07-20T18:49:59.308Z" },
          { label: "7d", usedPercentage: 50, resetsAt: "2026-07-25T10:00:00.000Z" },
          { label: "Fable 7d", usedPercentage: 52, resetsAt: "2026-07-25T10:00:00.000Z" },
        ]);
      }
      // Auth-files GET followed by an api-call POST.
      assert.strictEqual(calls.length, 2);
      assert.ok(calls[0]?.url.endsWith("/v0/management/auth-files"));
      assert.strictEqual(calls[0]?.headers.get("authorization"), "Bearer secret");
      assert.strictEqual(calls[1]?.method, "POST");
      assert.ok(calls[1]?.url.endsWith("/v0/management/api-call"));
    }).pipe(Effect.runPromise));

  it("reads Codex quota via api-call for a codex account", () =>
    Effect.gen(function* () {
      const { layer, calls } = mockUsageClient(({ url }) =>
        url.endsWith("/auth-files")
          ? {
              body: {
                files: [
                  {
                    provider: "codex",
                    auth_index: "cx1",
                    account_id: "acct-123",
                    email: "c@e.com",
                    status: "ready",
                  },
                ],
              },
            }
          : url.endsWith("/api-call")
            ? {
                body: {
                  status_code: 200,
                  body: JSON.stringify({
                    rate_limit: {
                      primary_window: {
                        used_percent: 7,
                        limit_window_seconds: 604800,
                        reset_at: 1785134475,
                      },
                    },
                  }),
                },
              }
            : { body: {} },
      );
      const outcome = yield* run(fetchCliProxyProviderUsage({ environment: claudeEnv }), layer);
      assert.strictEqual(outcome.kind, "available");
      if (outcome.kind === "available") {
        const entry = outcome.providers[0];
        assert.strictEqual(entry?.provider, "codex");
        assert.strictEqual(entry?.quotaWindows?.[0]?.label, "7d");
        assert.strictEqual(entry?.quotaWindows?.[0]?.usedPercentage, 7);
      }
      assert.strictEqual(calls.length, 2);
      assert.strictEqual(calls[1]?.method, "POST");
      assert.ok(calls[1]?.url.endsWith("/v0/management/api-call"));
    }).pipe(Effect.runPromise));

  it("still returns the account (status only) when the quota api-call fails", () =>
    Effect.gen(function* () {
      const { layer } = mockUsageClient(({ url }) =>
        url.endsWith("/auth-files")
          ? { body: { files: [{ provider: "claude", auth_index: "idx1", status: "ready" }] } }
          : { status: 500, body: { error: "upstream" } },
      );
      const outcome = yield* run(fetchCliProxyProviderUsage({ environment: claudeEnv }), layer);
      assert.strictEqual(outcome.kind, "available");
      if (outcome.kind === "available") {
        assert.strictEqual(outcome.providers[0]?.provider, "claude");
        assert.strictEqual(outcome.providers[0]?.quotaWindows, undefined);
      }
    }).pipe(Effect.runPromise));

  it("does not issue an api-call for unsupported providers", () =>
    Effect.gen(function* () {
      const { layer, calls } = mockUsageClient(({ url }) =>
        url.endsWith("/auth-files")
          ? { body: { files: [{ provider: "gemini", auth_index: "idx1", status: "ready" }] } }
          : { body: {} },
      );
      const outcome = yield* run(fetchCliProxyProviderUsage({ environment: claudeEnv }), layer);
      assert.strictEqual(outcome.kind, "available");
      assert.strictEqual(calls.length, 1);
    }).pipe(Effect.runPromise));

  it("reports failed on an auth-files HTTP error without throwing", () =>
    Effect.gen(function* () {
      const { layer } = mockUsageClient(() => ({ status: 403, body: { error: "nope" } }));
      const outcome = yield* run(fetchCliProxyProviderUsage({ environment: claudeEnv }), layer);
      assert.strictEqual(outcome.kind, "failed");
      if (outcome.kind === "failed") {
        assert.strictEqual(outcome.host, "localhost:8317");
        assert.strictEqual(outcome.detail, "request-failed");
      }
    }).pipe(Effect.runPromise));

  it("reports failed with unrecognized-response on a bad auth-files shape", () =>
    Effect.gen(function* () {
      const { layer } = mockUsageClient(() => ({ body: { unexpected: true } }));
      const outcome = yield* run(fetchCliProxyProviderUsage({ environment: claudeEnv }), layer);
      assert.strictEqual(outcome.kind, "failed");
      if (outcome.kind === "failed") {
        assert.strictEqual(outcome.detail, "unrecognized-response");
      }
    }).pipe(Effect.runPromise));
});
