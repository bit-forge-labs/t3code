/**
 * gatewayPayload — small pure guards for parsing untrusted JSON returned by a
 * custom Anthropic-compatible gateway (e.g. CLIProxyAPI). Shared by the gateway
 * discovery layers ({@link ./ClaudeModelDiscovery.ts},
 * {@link ./CliProxyUsageDiscovery.ts}) so the coercion rules stay in one place.
 *
 * @module provider/Layers/gatewayPayload
 */

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A trimmed non-empty string, or `undefined` for non-strings and blanks. */
export function trimmedNonEmpty(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/** A finite number, or `undefined` for non-numbers, NaN, and ±Infinity. */
export function finiteNumber(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  return value;
}

/** A finite value rounded to an integer ≥ 1, else `undefined`. */
export function positiveInt(value: unknown): number | undefined {
  const n = finiteNumber(value);
  if (n === undefined) return undefined;
  const rounded = Math.round(n);
  return rounded >= 1 ? rounded : undefined;
}

/** A finite value rounded to an integer ≥ 0, else `undefined`. */
export function nonNegativeInt(value: unknown): number | undefined {
  const n = finiteNumber(value);
  if (n === undefined) return undefined;
  const rounded = Math.round(n);
  return rounded >= 0 ? rounded : undefined;
}
