/**
 * CliProxyUsageDiscovery — fetch per-account usage/limits from a CLIProxyAPI
 * gateway's Management API, for a Claude instance configured through
 * `ANTHROPIC_BASE_URL`.
 *
 * A CLIProxyAPI gateway fronts several upstream accounts (Claude, Codex/ChatGPT,
 * Gemini, Grok, Kimi, …) and rotates across them on rate limits. We surface an
 * entry per account so the popover can show limits for all of them. Two calls:
 *
 *  1. `GET {base}/v0/management/auth-files` — the credential list with each
 *     account's provider, health status, request counts, and `auth_index`.
 *  2. `POST {base}/v0/management/api-call` — a generic authenticated proxy. For
 *     each Claude account we replay Claude Code's own usage request
 *     (`GET https://api.anthropic.com/api/oauth/usage`) via the stored
 *     credential (`$TOKEN$` is substituted by the gateway) to read the real
 *     subscription quota windows (5-hour + 7-day utilization and reset times) —
 *     the same data the CLIProxyAPI Management Center's "Quota Management" shows.
 *
 * This mirrors {@link ./ClaudeModelDiscovery.ts}: the Management API lives on the
 * same origin as the `/v1` proxy but authenticates with a distinct management key
 * (`CLIPROXY_MANAGEMENT_KEY`) — the ordinary gateway auth token does not open it.
 * The call is best-effort and never fails the caller: every outcome (ineligible,
 * available, failed) is reported as a {@link CliProxyUsageOutcome} so the provider
 * snapshot degrades gracefully. Credentials and response bodies are never logged.
 *
 * @module provider/Layers/CliProxyUsageDiscovery
 */
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { HttpClient } from "effect/unstable/http";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";

import { isFirstPartyAnthropicHost } from "./ClaudeModelDiscovery.ts";
import { finiteNumber, isRecord, nonNegativeInt, trimmedNonEmpty } from "./gatewayPayload.ts";

/**
 * Opaque failure for a management request. Deliberately carries no cause detail —
 * the transport error may reference credential-bearing request data, so only
 * success vs failure is exposed to the caller.
 */
class CliProxyUsageRequestError extends Schema.TaggedErrorClass<CliProxyUsageRequestError>()(
  "CliProxyUsageRequestError",
  {},
) {}

/** Upper bound on accounts surfaced, guarding against a hostile/huge payload. */
const MAX_USAGE_ACCOUNTS = 100;

/** Usage discovery is best-effort and must never dominate snapshot latency. */
const USAGE_TIMEOUT_MS = 4_000;

/** Cap on concurrent per-account quota probes. */
const QUOTA_CONCURRENCY = 4;

/** Claude Code's own subscription-usage endpoint, replayed via `/api-call`. */
const CLAUDE_USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
const CLAUDE_USAGE_HEADERS: Record<string, string> = {
  Authorization: "Bearer $TOKEN$",
  "Content-Type": "application/json",
  "anthropic-beta": "oauth-2025-04-20",
};

/** Codex/ChatGPT's own usage endpoint, replayed via `/api-call`. */
const CODEX_USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
const CODEX_USER_AGENT = "codex_cli_rs/0.76.0";

/**
 * Codex usage needs the `Chatgpt-Account-Id` header to select the workspace when
 * the token has several; sent when `/auth-files` reports one for the account.
 */
function codexUsageHeaders(accountId: string | undefined): Record<string, string> {
  return {
    Authorization: "Bearer $TOKEN$",
    "Content-Type": "application/json",
    "User-Agent": CODEX_USER_AGENT,
    ...(accountId ? { "Chatgpt-Account-Id": accountId } : {}),
  };
}

/** An upstream provider usage request to replay through `/api-call`. */
interface UpstreamUsageRequest {
  readonly url: string;
  readonly header: Record<string, string>;
}

// ── Public types ────────────────────────────────────────────────────

export type CliProxyUsageStatus = "ready" | "cooldown" | "disabled" | "unknown";

/** One subscription quota window (e.g. Claude's rolling 5h or 7-day cap). */
export interface CliProxyQuotaWindow {
  readonly label: string;
  /** 0..100 utilization of this window. */
  readonly usedPercentage: number;
  /** ISO-8601 instant this window resets, if reported. */
  readonly resetsAt?: string;
}

export interface CliProxyProviderUsage {
  readonly provider: string;
  readonly label?: string;
  readonly status: CliProxyUsageStatus;
  /** 0..100 single-quota fallback for providers that expose one on `/auth-files`. */
  readonly usedPercentage?: number;
  readonly successCount?: number;
  readonly failedCount?: number;
  /** Subscription windows read from the provider's own usage API (Claude today). */
  readonly quotaWindows?: ReadonlyArray<CliProxyQuotaWindow>;
}

export type CliProxyUsageOutcome =
  /** No custom gateway, a first-party Anthropic host, or no management key. */
  | { readonly kind: "ineligible" }
  /** Management API answered; `providers` may be empty. */
  | { readonly kind: "available"; readonly providers: ReadonlyArray<CliProxyProviderUsage> }
  /** The request failed or returned an unrecognized shape. */
  | { readonly kind: "failed"; readonly host: string; readonly detail: string };

export interface CliProxyManagementEndpoint {
  /** Base management URL, e.g. `http://host/v0/management`; no trailing slash. */
  readonly managementBaseUrl: string;
  /** Host (for safe logging); never includes credentials. */
  readonly host: string;
}

/** One account parsed from `/auth-files`, carrying its `auth_index` for `/api-call`. */
interface CliProxyCredential {
  readonly provider: string;
  readonly authIndex?: string;
  /** ChatGPT workspace/account id, needed for the Codex usage request. */
  readonly accountId?: string;
  readonly label?: string;
  readonly status: CliProxyUsageStatus;
  readonly usedPercentage?: number;
  readonly successCount?: number;
  readonly failedCount?: number;
}

// ── Endpoint eligibility (pure) ─────────────────────────────────────

/**
 * Resolve the `/v0/management` base URL for a custom `ANTHROPIC_BASE_URL`, or
 * `null` when usage discovery does not apply (absent/blank/malformed/non-HTTP
 * URL, or a first-party Anthropic host).
 *
 * The management API and the `/v1` proxy are siblings under the same base, so we
 * preserve any gateway path prefix — consistent with
 * {@link resolveClaudeModelsEndpoint}. A base ending in `/v1` (the proxy suffix)
 * has that segment stripped before appending the management path, so both a
 * direct gateway (`http://host` or `http://host/v1` → `http://host/v0/management`)
 * and a reverse-proxied one (`https://gw/anthropic` or `https://gw/anthropic/v1`
 * → `https://gw/anthropic/v0/management`) resolve correctly. Query/fragment are
 * dropped.
 */
export function resolveCliProxyManagementEndpoint(
  baseUrl: string | null | undefined,
): CliProxyManagementEndpoint | null {
  const trimmed = baseUrl?.trim();
  if (!trimmed) return null;

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  if (isFirstPartyAnthropicHost(url.host)) return null;

  const basePath = url.pathname.replace(/\/+$/u, "").replace(/\/v1$/u, "");

  return {
    managementBaseUrl: `${url.origin}${basePath}/v0/management`,
    host: url.host,
  };
}

// ── Payload parsing (pure) ──────────────────────────────────────────

/** Fold a single credential's raw state into a normalized status. */
function foldEntryStatus(entry: Record<string, unknown>): CliProxyUsageStatus {
  if (entry.disabled === true) return "disabled";
  if (entry.unavailable === true) return "cooldown";
  const raw = trimmedNonEmpty(entry.status)?.toLowerCase();
  if (!raw) return "unknown";
  if (["ready", "active", "ok", "available", "healthy"].includes(raw)) return "ready";
  if (
    ["cooldown", "cooling", "rate_limited", "ratelimited", "limited", "throttled"].includes(raw)
  ) {
    return "cooldown";
  }
  if (["disabled", "banned", "revoked", "expired"].includes(raw)) return "disabled";
  return "unknown";
}

/**
 * Opportunistically derive a 0..100 usage percentage from whatever quota-ish
 * fields a gateway happens to expose on an `/auth-files` entry. Returns
 * `undefined` when none are present (the common case). Accepts either a direct
 * percentage field or a used/limit pair.
 */
function parseUsedPercentage(entry: Record<string, unknown>): number | undefined {
  for (const key of ["used_percentage", "usage_percent", "usagePercentage", "percent_used"]) {
    const direct = finiteNumber(entry[key]);
    if (direct !== undefined) return clampPercentage(direct);
  }
  const used = finiteNumber(entry.used ?? entry.usage);
  const limit = finiteNumber(entry.limit ?? entry.quota ?? entry.total);
  if (used !== undefined && limit !== undefined && limit > 0) {
    return clampPercentage((used / limit) * 100);
  }
  const remaining = finiteNumber(entry.remaining);
  if (remaining !== undefined && limit !== undefined && limit > 0) {
    return clampPercentage(((limit - remaining) / limit) * 100);
  }
  return undefined;
}

function clampPercentage(value: number): number {
  return Math.max(0, Math.min(100, value));
}

/** A status code as a number, accepting both `200` and `"200"`. */
function numericStatus(value: unknown): number | undefined {
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value === "string") {
    const parsed = Number(value.trim());
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

/**
 * Ensure window labels are unique so they are safe as React keys and remain
 * distinguishable in the UI: the first occurrence keeps its label, later
 * duplicates get a " (2)", " (3)", … suffix.
 */
function dedupeWindowLabels(
  windows: ReadonlyArray<CliProxyQuotaWindow>,
): ReadonlyArray<CliProxyQuotaWindow> {
  const seen = new Map<string, number>();
  return windows.map((window) => {
    const count = (seen.get(window.label) ?? 0) + 1;
    seen.set(window.label, count);
    return count === 1 ? window : { ...window, label: `${window.label} (${count})` };
  });
}

/**
 * Best-effort extraction of a ChatGPT workspace/account id from an `/auth-files`
 * entry (needed for the Codex usage request). Checks common top-level keys and
 * one level of nesting, since builds vary in where they store it.
 */
function extractChatgptAccountId(entry: Record<string, unknown>): string | undefined {
  const direct = trimmedNonEmpty(
    entry.chatgpt_account_id ?? entry.chatgptAccountId ?? entry.account_id ?? entry.accountId,
  );
  if (direct) return direct;
  for (const key of ["account", "metadata", "chatgpt"]) {
    const nested = entry[key];
    if (!isRecord(nested)) continue;
    const id = trimmedNonEmpty(
      nested.chatgpt_account_id ??
        nested.chatgptAccountId ??
        nested.account_id ??
        nested.accountId ??
        nested.id,
    );
    if (id) return id;
  }
  return undefined;
}

function pickLabel(entry: Record<string, unknown>): string | undefined {
  return (
    trimmedNonEmpty(entry.label) ??
    trimmedNonEmpty(entry.email) ??
    trimmedNonEmpty(entry.account) ??
    trimmedNonEmpty(entry.name)
  );
}

function isoDateTime(value: unknown): string | undefined {
  const raw = trimmedNonEmpty(value);
  if (!raw) return undefined;
  return Option.match(DateTime.make(raw), {
    onNone: () => undefined,
    onSome: (instant) => DateTime.formatIso(instant),
  });
}

/** A Claude account whose subscription quota we can read via `/api-call`. */
export function isClaudeAccount(provider: string): boolean {
  const normalized = provider.trim().toLowerCase();
  return normalized === "claude" || normalized === "anthropic";
}

/** A Codex/ChatGPT account whose subscription quota we can read via `/api-call`. */
export function isCodexAccount(provider: string): boolean {
  const normalized = provider.trim().toLowerCase();
  return normalized === "codex" || normalized === "openai" || normalized === "chatgpt";
}

/** ISO-8601 from a Unix epoch-seconds value (Codex reset timestamps). */
function isoFromEpochSeconds(value: unknown): string | undefined {
  const seconds = finiteNumber(value);
  if (seconds === undefined) return undefined;
  return Option.match(DateTime.make(seconds * 1_000), {
    onNone: () => undefined,
    onSome: (instant) => DateTime.formatIso(instant),
  });
}

/** Short window label from a duration in seconds, e.g. 18000 → "5h", 604800 → "7d". */
function windowLabel(seconds: unknown): string {
  const total = finiteNumber(seconds);
  if (total === undefined || total <= 0) return "";
  if (total < 86_400) return `${Math.max(1, Math.round(total / 3_600))}h`;
  return `${Math.round(total / 86_400)}d`;
}

/** Trim a Codex `limit_name` like "GPT-5.3-Codex-Spark" down to "Spark". */
function shortCodexLimitName(name: string | undefined): string | undefined {
  if (!name) return undefined;
  const marker = name.toLowerCase().lastIndexOf("codex-");
  return trimmedNonEmpty(marker >= 0 ? name.slice(marker + "codex-".length) : name);
}

/**
 * Parse a `GET /v0/management/auth-files` payload into one record per account
 * (credential). Invalid entries are skipped; a recognized-but-empty file list
 * yields `[]`. Returns `null` only for an unrecognized envelope (no `files`
 * array).
 */
export function parseAuthFilesCredentials(
  payload: unknown,
): ReadonlyArray<CliProxyCredential> | null {
  if (!isRecord(payload) || !Array.isArray(payload.files)) return null;

  const out: Array<CliProxyCredential> = [];
  for (const raw of payload.files) {
    if (out.length >= MAX_USAGE_ACCOUNTS) break;
    if (!isRecord(raw)) continue;
    const provider = trimmedNonEmpty(raw.provider);
    if (!provider) continue;

    const authIndex = trimmedNonEmpty(raw.auth_index ?? raw.authIndex);
    const accountId = extractChatgptAccountId(raw);
    const label = pickLabel(raw);
    const successCount = nonNegativeInt(raw.success);
    const failedCount = nonNegativeInt(raw.failed);
    const usedPercentage = parseUsedPercentage(raw);

    out.push({
      provider,
      ...(authIndex ? { authIndex } : {}),
      ...(accountId ? { accountId } : {}),
      ...(label ? { label } : {}),
      status: foldEntryStatus(raw),
      ...(usedPercentage !== undefined ? { usedPercentage } : {}),
      ...(successCount !== undefined ? { successCount } : {}),
      ...(failedCount !== undefined ? { failedCount } : {}),
    });
  }
  return out;
}

/**
 * Unwrap an `/api-call` response envelope (`{ status_code, header, body }`) into
 * the upstream body JSON. Returns `null` for a non-200 upstream status, a
 * non-string body, or unparseable JSON.
 */
export function parseApiCallUsageBody(payload: unknown): unknown {
  if (!isRecord(payload)) return null;
  if (numericStatus(payload.status_code) !== 200) return null;
  if (typeof payload.body !== "string") return null;
  try {
    return JSON.parse(payload.body);
  } catch {
    return null;
  }
}

/**
 * Extract quota windows from Claude's `/api/oauth/usage` response: the top-level
 * `five_hour` and `seven_day` caps, plus any model-scoped weekly caps from the
 * `limits` array (e.g. a per-model "Fable" weekly limit). Windows with an
 * unreadable utilization are skipped; the array is empty when none are present.
 */
export function parseClaudeQuotaWindows(usage: unknown): ReadonlyArray<CliProxyQuotaWindow> {
  if (!isRecord(usage)) return [];
  const windows: Array<CliProxyQuotaWindow> = [];
  for (const [key, label] of [
    ["five_hour", "5h"],
    ["seven_day", "7d"],
  ] as const) {
    const window = usage[key];
    if (!isRecord(window)) continue;
    const utilization = finiteNumber(window.utilization);
    if (utilization === undefined) continue;
    const resetsAt = isoDateTime(window.resets_at);
    windows.push({
      label,
      usedPercentage: clampPercentage(utilization),
      ...(resetsAt ? { resetsAt } : {}),
    });
  }
  // Model-scoped weekly caps (e.g. Fable) are only in the `limits` array.
  if (Array.isArray(usage.limits)) {
    for (const limit of usage.limits) {
      if (!isRecord(limit) || limit.kind !== "weekly_scoped") continue;
      const scope = isRecord(limit.scope) ? limit.scope : undefined;
      const model =
        scope && isRecord(scope.model) ? trimmedNonEmpty(scope.model.display_name) : undefined;
      const percent = finiteNumber(limit.percent);
      if (!model || percent === undefined) continue;
      const resetsAt = isoDateTime(limit.resets_at);
      windows.push({
        label: `${model} 7d`,
        usedPercentage: clampPercentage(percent),
        ...(resetsAt ? { resetsAt } : {}),
      });
    }
  }
  return dedupeWindowLabels(windows);
}

/**
 * Extract quota windows from Codex's `/backend-api/wham/usage` response: the
 * account-wide `rate_limit` (primary/secondary windows) plus any
 * `additional_rate_limits` (e.g. a "Codex-Spark" per-feature cap). Each window's
 * label is derived from its duration ("7d"), prefixed with the feature name for
 * additional limits ("Spark 7d"). Empty when none are present.
 */
export function parseCodexQuotaWindows(usage: unknown): ReadonlyArray<CliProxyQuotaWindow> {
  if (!isRecord(usage)) return [];
  const windows: Array<CliProxyQuotaWindow> = [];

  const pushWindows = (rateLimit: unknown, prefix: string | undefined) => {
    if (!isRecord(rateLimit)) return;
    for (const key of ["primary_window", "secondary_window"] as const) {
      const window = rateLimit[key];
      if (!isRecord(window)) continue;
      const used = finiteNumber(window.used_percent);
      if (used === undefined) continue;
      const base = windowLabel(window.limit_window_seconds);
      const label = prefix ? `${prefix}${base ? ` ${base}` : ""}` : base || "Usage";
      const resetsAt = isoFromEpochSeconds(window.reset_at);
      windows.push({
        label,
        usedPercentage: clampPercentage(used),
        ...(resetsAt ? { resetsAt } : {}),
      });
    }
  };

  pushWindows(usage.rate_limit, undefined);
  if (Array.isArray(usage.additional_rate_limits)) {
    for (const limit of usage.additional_rate_limits) {
      if (!isRecord(limit)) continue;
      // Require a name prefix so an additional limit can't be labeled by duration
      // alone and collide with the account-wide window (e.g. both "7d").
      const prefix =
        shortCodexLimitName(trimmedNonEmpty(limit.limit_name)) ??
        trimmedNonEmpty(limit.metered_feature);
      if (!prefix) continue;
      pushWindows(limit.rate_limit, prefix);
    }
  }
  return dedupeWindowLabels(windows);
}

function toProviderUsage(
  credential: CliProxyCredential,
  quotaWindows: ReadonlyArray<CliProxyQuotaWindow>,
): CliProxyProviderUsage {
  return {
    provider: credential.provider,
    ...(credential.label ? { label: credential.label } : {}),
    status: credential.status,
    ...(credential.usedPercentage !== undefined
      ? { usedPercentage: credential.usedPercentage }
      : {}),
    ...(credential.successCount !== undefined ? { successCount: credential.successCount } : {}),
    ...(credential.failedCount !== undefined ? { failedCount: credential.failedCount } : {}),
    ...(quotaWindows.length > 0 ? { quotaWindows } : {}),
  };
}

// ── HTTP discovery ──────────────────────────────────────────────────

function applyManagementAuth(
  request: HttpClientRequest.HttpClientRequest,
  managementKey: string,
): HttpClientRequest.HttpClientRequest {
  // CLIProxyAPI accepts the management key as a bearer token or via
  // `X-Management-Key`; send both so either gateway configuration authenticates.
  return request.pipe(
    HttpClientRequest.bearerToken(managementKey),
    HttpClientRequest.setHeader("X-Management-Key", managementKey),
  );
}

/** GET the credential list. Fails (opaque) on any transport/decode/timeout error. */
const fetchAuthFilesCredentials = (
  endpoint: CliProxyManagementEndpoint,
  managementKey: string,
): Effect.Effect<
  ReadonlyArray<CliProxyCredential> | null,
  CliProxyUsageRequestError,
  HttpClient.HttpClient
> =>
  Effect.gen(function* () {
    const httpClient = yield* HttpClient.HttpClient;
    const request = HttpClientRequest.get(`${endpoint.managementBaseUrl}/auth-files`).pipe(
      HttpClientRequest.acceptJson,
      (base) => applyManagementAuth(base, managementKey),
    );
    const payload = yield* httpClient.execute(request).pipe(
      Effect.flatMap(HttpClientResponse.filterStatusOk),
      Effect.flatMap((response) => response.json),
      Effect.timeout(USAGE_TIMEOUT_MS),
      Effect.mapError(() => new CliProxyUsageRequestError()),
    );
    return parseAuthFilesCredentials(payload);
  });

/**
 * Read one account's subscription quota by replaying its provider usage request
 * through `/api-call` and parsing the upstream body. Best-effort: any failure
 * resolves to `[]` (no windows) rather than failing the whole snapshot.
 */
const fetchAccountQuotaWindows = (
  endpoint: CliProxyManagementEndpoint,
  managementKey: string,
  authIndex: string,
  usageRequest: UpstreamUsageRequest,
  parse: (body: unknown) => ReadonlyArray<CliProxyQuotaWindow>,
): Effect.Effect<ReadonlyArray<CliProxyQuotaWindow>, never, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const httpClient = yield* HttpClient.HttpClient;
    const request = HttpClientRequest.post(`${endpoint.managementBaseUrl}/api-call`).pipe(
      HttpClientRequest.acceptJson,
      (base) => applyManagementAuth(base, managementKey),
      HttpClientRequest.bodyJsonUnsafe({
        authIndex,
        method: "GET",
        url: usageRequest.url,
        header: usageRequest.header,
      }),
    );
    const payload = yield* httpClient.execute(request).pipe(
      Effect.flatMap(HttpClientResponse.filterStatusOk),
      Effect.flatMap((response) => response.json),
      Effect.timeout(USAGE_TIMEOUT_MS),
      Effect.mapError(() => new CliProxyUsageRequestError()),
    );
    return parse(parseApiCallUsageBody(payload));
  }).pipe(Effect.orElseSucceed(() => []));

/** The upstream usage request + parser for an account, or `null` if unsupported. */
function usageProbeFor(credential: CliProxyCredential): {
  request: UpstreamUsageRequest;
  parse: (body: unknown) => ReadonlyArray<CliProxyQuotaWindow>;
} | null {
  if (isClaudeAccount(credential.provider)) {
    return {
      request: { url: CLAUDE_USAGE_URL, header: CLAUDE_USAGE_HEADERS },
      parse: parseClaudeQuotaWindows,
    };
  }
  if (isCodexAccount(credential.provider)) {
    return {
      request: { url: CODEX_USAGE_URL, header: codexUsageHeaders(credential.accountId) },
      parse: parseCodexQuotaWindows,
    };
  }
  return null;
}

/**
 * Fetch per-account usage from the gateway referenced by `ANTHROPIC_BASE_URL` in
 * `environment`, authenticated with `CLIPROXY_MANAGEMENT_KEY`. Never fails —
 * always resolves to a {@link CliProxyUsageOutcome}. `ineligible` when no gateway
 * or no management key is configured.
 */
export const fetchCliProxyProviderUsage = (input: {
  readonly environment: NodeJS.ProcessEnv;
}): Effect.Effect<CliProxyUsageOutcome, never, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const endpoint = resolveCliProxyManagementEndpoint(input.environment.ANTHROPIC_BASE_URL);
    if (!endpoint) {
      return { kind: "ineligible" } satisfies CliProxyUsageOutcome;
    }
    const managementKey = input.environment.CLIPROXY_MANAGEMENT_KEY?.trim();
    if (!managementKey) {
      // The Management API rejects unauthenticated requests even on localhost, so
      // without a key there is nothing to fetch.
      return { kind: "ineligible" } satisfies CliProxyUsageOutcome;
    }

    const credentialsResult = yield* fetchAuthFilesCredentials(endpoint, managementKey).pipe(
      Effect.result,
    );
    if (!Result.isSuccess(credentialsResult)) {
      return {
        kind: "failed",
        host: endpoint.host,
        detail: "request-failed",
      } satisfies CliProxyUsageOutcome;
    }
    const credentials = credentialsResult.success;
    if (credentials === null) {
      return {
        kind: "failed",
        host: endpoint.host,
        detail: "unrecognized-response",
      } satisfies CliProxyUsageOutcome;
    }

    // Read subscription quota for each supported account concurrently
    // (best-effort); other providers surface status + request counts only.
    const providers = yield* Effect.forEach(
      credentials,
      (credential) => {
        const probe = credential.authIndex ? usageProbeFor(credential) : null;
        if (!probe || !credential.authIndex) {
          return Effect.succeed(toProviderUsage(credential, []));
        }
        return fetchAccountQuotaWindows(
          endpoint,
          managementKey,
          credential.authIndex,
          probe.request,
          probe.parse,
        ).pipe(Effect.map((windows) => toProviderUsage(credential, windows)));
      },
      { concurrency: QUOTA_CONCURRENCY },
    );

    return { kind: "available", providers } satisfies CliProxyUsageOutcome;
  }).pipe(
    // Defensive: any unexpected defect degrades to a safe "failed" outcome rather
    // than surfacing a credential-bearing cause.
    Effect.catchCause(() =>
      Effect.succeed({
        kind: "failed",
        host:
          resolveCliProxyManagementEndpoint(input.environment.ANTHROPIC_BASE_URL)?.host ??
          "unknown",
        detail: "request-failed",
      } satisfies CliProxyUsageOutcome),
    ),
  );
