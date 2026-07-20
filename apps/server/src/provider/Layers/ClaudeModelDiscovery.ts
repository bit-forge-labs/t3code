/**
 * ClaudeModelDiscovery — discover models advertised by a custom Anthropic-
 * compatible gateway (e.g. CLIProxyAPI) configured through `ANTHROPIC_BASE_URL`.
 *
 * The built-in Claude catalog is a static, version-gated allowlist of `claude-*`
 * slugs (see {@link ../Layers/ClaudeProvider.ts}). When a Claude instance points
 * at a gateway that fronts non-Anthropic models, those models are invisible to
 * T3 Code. This module asks the gateway for its catalog and maps the result into
 * neutral {@link ClaudeDiscoveredModel} records that the provider layer merges
 * with the built-ins.
 *
 * ## Two response shapes
 *
 * CLIProxyAPI's ordinary `GET /v1/models` intentionally returns only minimal
 * OpenAI fields (`id`/`object`/`created`/`owned_by`) — no capabilities. Current
 * versions expose a richer catalog when any `client_version` query parameter is
 * present, returning a Codex-style `{ models: [...] }` envelope with context
 * limits and reasoning levels. We therefore request the expanded variant first
 * and fall back to the plain endpoint, detecting which shape actually came back
 * rather than trusting that the gateway honored the parameter.
 *
 * The request never fails the caller: every outcome (including timeouts and HTTP
 * errors) is reported as a {@link ClaudeModelDiscoveryOutcome} so the provider
 * snapshot can degrade gracefully. Credentials and response bodies are never
 * logged.
 *
 * @module provider/Layers/ClaudeModelDiscovery
 */
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { HttpClient } from "effect/unstable/http";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";

/**
 * Opaque failure for a single catalog request. Deliberately carries no cause
 * detail — the transport error may reference credential-bearing request data,
 * so only success vs failure is exposed to the caller.
 */
class ClaudeModelDiscoveryRequestError extends Schema.TaggedErrorClass<ClaudeModelDiscoveryRequestError>()(
  "ClaudeModelDiscoveryRequestError",
  {},
) {}

/** Upper bound on discovered models, guarding against a hostile/huge catalog. */
const MAX_DISCOVERED_MODELS = 1_000;

/** Discovery is best-effort and must never dominate snapshot latency. */
const DISCOVERY_TIMEOUT_MS = 4_000;

/** Stable identifier sent when the installed Claude Code version is unknown. */
const FALLBACK_CLIENT_VERSION = "t3-code";

// ── Public types ────────────────────────────────────────────────────

export interface ClaudeDiscoveredEffortLevel {
  readonly value: string;
  readonly description?: string;
  readonly isDefault?: boolean;
}

export interface ClaudeDiscoveredModel {
  readonly slug: string;
  readonly name: string;
  readonly description?: string;
  readonly contextWindowTokens?: number;
  readonly maxContextWindowTokens?: number;
  /** Present only for the expanded catalog tier. */
  readonly effortLevels?: ReadonlyArray<ClaudeDiscoveredEffortLevel>;
}

export type ClaudeModelDiscoveryTier = "expanded" | "standard";

export type ClaudeModelDiscoveryOutcome =
  /** No custom gateway configured (or a first-party Anthropic endpoint). */
  | { readonly kind: "ineligible" }
  /** A recognized catalog was returned (may be empty). */
  | {
      readonly kind: "discovered";
      readonly tier: ClaudeModelDiscoveryTier;
      readonly models: ReadonlyArray<ClaudeDiscoveredModel>;
    }
  /** Both attempts failed or returned an unrecognized shape. */
  | { readonly kind: "failed"; readonly host: string; readonly detail: string };

export interface ClaudeDiscoveryEndpoint {
  /** Fully-qualified `.../v1/models` URL, no query string. */
  readonly modelsUrl: string;
  /** Host (for safe logging); never includes credentials. */
  readonly host: string;
}

// ── Endpoint eligibility (pure) ─────────────────────────────────────

/**
 * First-party Anthropic hosts never expose a discoverable third-party catalog
 * and must not receive the `client_version` probe.
 */
export function isFirstPartyAnthropicHost(host: string): boolean {
  const normalized = host.trim().toLowerCase();
  return normalized === "anthropic.com" || normalized.endsWith(".anthropic.com");
}

/**
 * Resolve the `/v1/models` endpoint for a custom `ANTHROPIC_BASE_URL`, or
 * `null` when discovery does not apply (absent/blank/malformed/non-HTTP URL, or
 * a first-party Anthropic host). Preserves any gateway path prefix and drops
 * query/fragment. A base already ending in `/v1` gets `/models` appended rather
 * than `/v1/v1/models`.
 */
export function resolveClaudeModelsEndpoint(
  baseUrl: string | null | undefined,
): ClaudeDiscoveryEndpoint | null {
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

  const basePath = url.pathname.replace(/\/+$/u, "");
  const modelsPath = basePath.endsWith("/v1") ? `${basePath}/models` : `${basePath}/v1/models`;

  return {
    modelsUrl: `${url.origin}${modelsPath}`,
    host: url.host,
  };
}

// ── Payload parsing (pure) ──────────────────────────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function trimmedNonEmpty(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function positiveInt(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  const rounded = Math.round(value);
  return rounded >= 1 ? rounded : undefined;
}

function parseExpandedEffortLevels(
  entry: Record<string, unknown>,
): ReadonlyArray<ClaudeDiscoveredEffortLevel> | undefined {
  const raw = entry.supported_reasoning_levels;
  if (!Array.isArray(raw)) return undefined;

  const defaultValue = trimmedNonEmpty(entry.default_reasoning_level);
  const seen = new Set<string>();
  const levels: Array<ClaudeDiscoveredEffortLevel> = [];
  for (const item of raw) {
    if (!isRecord(item)) continue;
    const value = trimmedNonEmpty(item.effort);
    if (!value || seen.has(value)) continue;
    seen.add(value);
    const description = trimmedNonEmpty(item.description);
    levels.push({
      value,
      ...(description ? { description } : {}),
      ...(defaultValue === value ? { isDefault: true } : {}),
    });
  }
  return levels.length > 0 ? levels : undefined;
}

function parseExpandedEntry(entry: unknown): ClaudeDiscoveredModel | null {
  if (!isRecord(entry)) return null;
  const slug = trimmedNonEmpty(entry.slug);
  if (!slug) return null;

  const name = trimmedNonEmpty(entry.display_name) ?? slug;
  const description = trimmedNonEmpty(entry.description);
  const contextWindowTokens = positiveInt(entry.context_window);
  const maxContextWindowTokens = positiveInt(entry.max_context_window);
  const effortLevels = parseExpandedEffortLevels(entry);

  return {
    slug,
    name,
    ...(description ? { description } : {}),
    ...(contextWindowTokens !== undefined ? { contextWindowTokens } : {}),
    ...(maxContextWindowTokens !== undefined ? { maxContextWindowTokens } : {}),
    ...(effortLevels ? { effortLevels } : {}),
  };
}

function parseStandardEntry(entry: unknown): ClaudeDiscoveredModel | null {
  if (!isRecord(entry)) return null;
  const slug = trimmedNonEmpty(entry.id);
  if (!slug) return null;
  return { slug, name: slug };
}

function dedupeBySlug(
  models: ReadonlyArray<ClaudeDiscoveredModel>,
): ReadonlyArray<ClaudeDiscoveredModel> {
  const seen = new Set<string>();
  const out: Array<ClaudeDiscoveredModel> = [];
  for (const model of models) {
    if (seen.has(model.slug) || out.length >= MAX_DISCOVERED_MODELS) continue;
    seen.add(model.slug);
    out.push(model);
  }
  return out;
}

/**
 * Detect the catalog shape and map entries. Invalid entries are discarded; a
 * recognized-but-empty catalog still returns `{ models: [] }`. Returns `null`
 * only for an unrecognized envelope (neither `models` nor `data` array).
 */
export function parseClaudeDiscoveryPayload(
  payload: unknown,
): {
  readonly tier: ClaudeModelDiscoveryTier;
  readonly models: ReadonlyArray<ClaudeDiscoveredModel>;
} | null {
  if (!isRecord(payload)) return null;

  if (Array.isArray(payload.models)) {
    return {
      tier: "expanded",
      models: dedupeBySlug(
        payload.models.flatMap((entry) => {
          const model = parseExpandedEntry(entry);
          return model ? [model] : [];
        }),
      ),
    };
  }

  if (Array.isArray(payload.data)) {
    return {
      tier: "standard",
      models: dedupeBySlug(
        payload.data.flatMap((entry) => {
          const model = parseStandardEntry(entry);
          return model ? [model] : [];
        }),
      ),
    };
  }

  return null;
}

// ── HTTP discovery ──────────────────────────────────────────────────

function applyDiscoveryAuth(
  request: HttpClientRequest.HttpClientRequest,
  environment: NodeJS.ProcessEnv,
): HttpClientRequest.HttpClientRequest {
  // Mirror Claude Code's own precedence: an explicit auth token is sent as a
  // bearer, otherwise the API key uses the `x-api-key` header. Never both, so a
  // gateway that rejects duplicate credentials still authenticates. A local
  // gateway may accept an unauthenticated request.
  const authToken = environment.ANTHROPIC_AUTH_TOKEN?.trim();
  if (authToken) {
    return request.pipe(HttpClientRequest.bearerToken(authToken));
  }
  const apiKey = environment.ANTHROPIC_API_KEY?.trim();
  if (apiKey) {
    return request.pipe(HttpClientRequest.setHeader("x-api-key", apiKey));
  }
  return request;
}

const requestCatalog = (
  url: string,
  environment: NodeJS.ProcessEnv,
): Effect.Effect<
  {
    readonly tier: ClaudeModelDiscoveryTier;
    readonly models: ReadonlyArray<ClaudeDiscoveredModel>;
  } | null,
  ClaudeModelDiscoveryRequestError,
  HttpClient.HttpClient
> =>
  Effect.gen(function* () {
    const httpClient = yield* HttpClient.HttpClient;
    const request = HttpClientRequest.get(url).pipe(
      HttpClientRequest.acceptJson,
      HttpClientRequest.setHeader("anthropic-version", "2023-06-01"),
      (base) => applyDiscoveryAuth(base, environment),
    );
    // Redirects are not followed by this client, so `filterStatusOk` rejects any
    // 3xx — no cross-origin credential leak is possible.
    const payload = yield* httpClient.execute(request).pipe(
      Effect.flatMap(HttpClientResponse.filterStatusOk),
      Effect.flatMap((response) => response.json),
      Effect.timeout(DISCOVERY_TIMEOUT_MS),
      // Collapse the transport/decode/timeout error union into one opaque tagged
      // error; the caller only distinguishes success from failure and must never
      // log a credential-bearing cause.
      Effect.mapError(() => new ClaudeModelDiscoveryRequestError()),
    );
    return parseClaudeDiscoveryPayload(payload);
  });

/**
 * Discover models from the gateway referenced by `ANTHROPIC_BASE_URL` in
 * `environment`. Requests the expanded catalog first, falling back to the plain
 * `/v1/models` endpoint on any failure or unrecognized shape. Never fails —
 * always resolves to a {@link ClaudeModelDiscoveryOutcome}.
 */
export const discoverClaudeGatewayModels = (input: {
  readonly environment: NodeJS.ProcessEnv;
  readonly clientVersion: string | null | undefined;
}): Effect.Effect<ClaudeModelDiscoveryOutcome, never, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const endpoint = resolveClaudeModelsEndpoint(input.environment.ANTHROPIC_BASE_URL);
    if (!endpoint) {
      return { kind: "ineligible" } satisfies ClaudeModelDiscoveryOutcome;
    }

    const clientVersion = input.clientVersion?.trim() || FALLBACK_CLIENT_VERSION;
    const expandedUrl = `${endpoint.modelsUrl}?client_version=${encodeURIComponent(clientVersion)}`;

    // Expanded-first: a recognized shape (expanded OR standard) is accepted
    // immediately, since some gateways ignore the query parameter and simply
    // return their plain catalog.
    const expanded = yield* requestCatalog(expandedUrl, input.environment).pipe(Effect.result);
    if (Result.isSuccess(expanded) && expanded.success !== null) {
      return {
        kind: "discovered",
        tier: expanded.success.tier,
        models: expanded.success.models,
      } satisfies ClaudeModelDiscoveryOutcome;
    }

    // Fall back to the ordinary endpoint (rejected/malformed/unknown expanded).
    const standard = yield* requestCatalog(endpoint.modelsUrl, input.environment).pipe(
      Effect.result,
    );
    if (Result.isSuccess(standard) && standard.success !== null) {
      return {
        kind: "discovered",
        tier: standard.success.tier,
        models: standard.success.models,
      } satisfies ClaudeModelDiscoveryOutcome;
    }

    const detail =
      Result.isSuccess(expanded) && expanded.success === null
        ? "unrecognized-response"
        : "request-failed";
    return { kind: "failed", host: endpoint.host, detail } satisfies ClaudeModelDiscoveryOutcome;
  }).pipe(
    // Defensive: any unexpected defect degrades to a safe "failed" outcome
    // rather than surfacing a credential-bearing cause.
    Effect.catchCause(() =>
      Effect.succeed({
        kind: "failed",
        host: resolveClaudeModelsEndpoint(input.environment.ANTHROPIC_BASE_URL)?.host ?? "unknown",
        detail: "request-failed",
      } satisfies ClaudeModelDiscoveryOutcome),
    ),
  );
