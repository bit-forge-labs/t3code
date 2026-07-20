import { useState } from "react";
import type {
  ServerProviderQuotaWindow,
  ServerProviderUsage,
  ServerProviderUsageEntry,
} from "@t3tools/contracts";
import { cn } from "~/lib/utils";
import { type ContextWindowSnapshot, formatContextWindowTokens } from "~/lib/contextWindow";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";

function formatPercentage(value: number | null): string | null {
  if (value === null || !Number.isFinite(value)) {
    return null;
  }
  if (value < 10) {
    return `${value.toFixed(1).replace(/\.0$/, "")}%`;
  }
  return `${Math.round(value)}%`;
}

const PROVIDER_LABELS: Record<string, string> = {
  claude: "Claude",
  anthropic: "Claude",
  openai: "OpenAI",
  codex: "Codex",
  gemini: "Gemini",
  grok: "Grok",
  xai: "xAI",
  kimi: "Kimi",
  antigravity: "Antigravity",
  copilot: "Copilot",
  qwen: "Qwen",
};

/** Human-readable provider name, e.g. "claude" → "Claude", "openai" → "OpenAI". */
function formatProviderLabel(provider: string): string {
  const key = provider.trim().toLowerCase();
  return PROVIDER_LABELS[key] ?? provider.charAt(0).toUpperCase() + provider.slice(1);
}

/**
 * Partially mask an email's local part while keeping the domain, e.g.
 * "minecraftboss4@gmail.com" → "m***4@gmail.com". Non-email labels are returned
 * unchanged.
 */
function maskEmail(value: string): string {
  const at = value.lastIndexOf("@");
  if (at <= 0) return value;
  const local = value.slice(0, at);
  const domain = value.slice(at);
  const masked =
    local.length <= 2
      ? `${local[0] ?? ""}*`
      : `${local[0]}${"*".repeat(Math.min(3, local.length - 2))}${local[local.length - 1]}`;
  return `${masked}${domain}`;
}

const USAGE_STATUS_META: Record<
  ServerProviderUsageEntry["status"],
  { readonly label: string; readonly color: string }
> = {
  ready: { label: "Ready", color: "var(--color-green-500)" },
  cooldown: { label: "Cooldown", color: "var(--color-amber-500)" },
  disabled: { label: "Disabled", color: "var(--color-red-500)" },
  unknown: { label: "Unknown", color: "var(--color-muted-foreground)" },
};

function quotaBarColor(percentage: number): string {
  if (percentage > 90) return "var(--color-red-500)";
  if (percentage > 75) return "var(--color-amber-500)";
  return "var(--color-blue-500)";
}

/**
 * Absolute local reset time, e.g. "resets 6:49 PM" (same day) or
 * "resets Jul 25, 10:00 AM". Rendered whether the boundary is future or already
 * elapsed (a rolling window's reset can be in the past while idle), so the reset
 * always shows when the provider reports one. Null when absent/unparseable.
 */
function formatQuotaReset(iso: string | undefined): string | null {
  if (!iso) return null;
  const parsed = Date.parse(iso);
  if (!Number.isFinite(parsed)) return null;
  const resetAt = new Date(parsed);
  const sameDay = resetAt.toDateString() === new Date().toDateString();
  const options: Intl.DateTimeFormatOptions = sameDay
    ? { hour: "numeric", minute: "2-digit" }
    : { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" };
  return `resets ${resetAt.toLocaleString(undefined, options)}`;
}

function QuotaWindowBar({ window: quotaWindow }: { window: ServerProviderQuotaWindow }) {
  const percentage = Math.max(0, Math.min(100, quotaWindow.usedPercentage));
  const resetIn = formatQuotaReset(quotaWindow.resetsAt);
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center justify-between gap-2 text-[11px] leading-4">
        <span className="text-muted-foreground/70">{quotaWindow.label}</span>
        <span className="flex items-baseline gap-1.5 tabular-nums">
          {resetIn ? (
            <>
              <span className="text-[10px] text-muted-foreground/40">{resetIn}</span>
              <span className="text-muted-foreground/40">·</span>
            </>
          ) : null}
          <span className="text-muted-foreground/70">{formatPercentage(percentage)}</span>
        </span>
      </div>
      <div
        className="h-1 w-full overflow-hidden rounded-full bg-muted/60"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(percentage)}
        aria-label={`${quotaWindow.label} quota used`}
      >
        <div
          className="h-full rounded-full"
          style={{ width: `${percentage}%`, backgroundColor: quotaBarColor(percentage) }}
        />
      </div>
    </div>
  );
}

function ProviderUsageRow({ entry }: { entry: ServerProviderUsageEntry }) {
  const statusMeta = USAGE_STATUS_META[entry.status];
  // Real subscription windows when available (Claude 5h/7d); otherwise a single
  // generic quota bar; otherwise nothing but the status + request counts.
  const windows: ReadonlyArray<ServerProviderQuotaWindow> =
    entry.quotaWindows && entry.quotaWindows.length > 0
      ? entry.quotaWindows
      : entry.usedPercentage !== undefined
        ? [{ label: "Usage", usedPercentage: entry.usedPercentage }]
        : [];
  const hasCounts = entry.successCount !== undefined || entry.failedCount !== undefined;
  const [emailRevealed, setEmailRevealed] = useState(false);
  const accountLabel = entry.label;

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center justify-between gap-3 text-[11px] leading-4">
        {accountLabel ? (
          <button
            type="button"
            onClick={() => setEmailRevealed((revealed) => !revealed)}
            className="min-w-0 cursor-pointer truncate text-left text-muted-foreground/60 transition-colors hover:text-muted-foreground/90"
            title={emailRevealed ? "Hide email" : "Show full email"}
            aria-label={emailRevealed ? "Hide full email" : "Show full email"}
          >
            {emailRevealed ? accountLabel : maskEmail(accountLabel)}
          </button>
        ) : (
          <span className="min-w-0" />
        )}
        <span className="flex shrink-0 items-center gap-1 text-muted-foreground/70">
          <span
            className="inline-block size-1.5 rounded-full"
            style={{ backgroundColor: statusMeta.color }}
            aria-hidden="true"
          />
          {statusMeta.label}
        </span>
      </div>
      {windows.length > 0 ? (
        <div className="flex flex-col gap-1.5">
          {windows.map((quotaWindow) => (
            <QuotaWindowBar key={quotaWindow.label} window={quotaWindow} />
          ))}
        </div>
      ) : hasCounts ? (
        <div className="flex items-center gap-2 text-[10px] tabular-nums text-muted-foreground/50">
          <span>{entry.successCount ?? 0} ok</span>
          <span>·</span>
          <span>{entry.failedCount ?? 0} failed</span>
        </div>
      ) : null}
    </div>
  );
}

/** Group per-account entries by provider, preserving first-seen order. */
function groupByProvider(
  entries: ReadonlyArray<ServerProviderUsageEntry>,
): ReadonlyArray<{ provider: string; entries: ReadonlyArray<ServerProviderUsageEntry> }> {
  const groups: Array<{ provider: string; entries: Array<ServerProviderUsageEntry> }> = [];
  const indexByProvider = new Map<string, number>();
  for (const entry of entries) {
    const existing = indexByProvider.get(entry.provider);
    if (existing === undefined) {
      indexByProvider.set(entry.provider, groups.length);
      groups.push({ provider: entry.provider, entries: [entry] });
    } else {
      groups[existing]?.entries.push(entry);
    }
  }
  return groups;
}

function ProviderUsageSection({
  usage,
  divided,
}: {
  usage: ServerProviderUsage;
  divided: boolean;
}) {
  if (usage.providers.length === 0) {
    return null;
  }
  return (
    <div className={cn("flex flex-col gap-3 p-3", divided && "border-border/60 border-t")}>
      {groupByProvider(usage.providers).map((group) => (
        <div key={group.provider} className="flex flex-col gap-2">
          <div className="font-medium text-muted-foreground text-xs">
            {formatProviderLabel(group.provider)}
          </div>
          <div className="flex flex-col gap-2.5">
            {group.entries.map((entry, index) => (
              <ProviderUsageRow key={entry.label ?? `${group.provider}#${index}`} entry={entry} />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

export function ContextWindowMeter(props: {
  usage: ContextWindowSnapshot | null;
  providerDisplayName?: string | null;
  providerUsage?: ServerProviderUsage | null;
}) {
  const { usage, providerDisplayName, providerUsage } = props;
  const hasProviderUsage = providerUsage != null && providerUsage.providers.length > 0;
  // Nothing to show — the meter is driven by context-window data and/or provider
  // usage; render nothing rather than an empty popover.
  if (!usage && !hasProviderUsage) {
    return null;
  }
  const usedPercentage = usage ? formatPercentage(usage.usedPercentage) : null;
  const normalizedPercentage = usage ? Math.max(0, Math.min(100, usage.usedPercentage ?? 0)) : 0;
  const radius = 9.75;
  const circumference = 2 * Math.PI * radius;
  const dashOffset = circumference - (normalizedPercentage / 100) * circumference;
  const totalProcessedTokens = usage?.totalProcessedTokens ?? null;
  const showTotalProcessed = totalProcessedTokens !== null && totalProcessedTokens > 0;
  const isOverloaded = normalizedPercentage > 90;
  const usageColor = isOverloaded ? "var(--color-red-500)" : "var(--color-blue-500)";

  return (
    <Popover>
      <PopoverTrigger
        openOnHover
        delay={150}
        closeDelay={0}
        render={
          <button
            type="button"
            className={cn(
              "inline-flex size-6 cursor-pointer items-center justify-center rounded-full border border-transparent text-muted-foreground outline-none transition-colors",
              "hover:bg-accent data-[pressed]:bg-accent",
              "focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background",
            )}
            aria-label={
              usage
                ? usage.maxTokens !== null && usedPercentage
                  ? `Context window ${usedPercentage} used`
                  : `Context window ${formatContextWindowTokens(usage.usedTokens)} tokens used`
                : "Provider usage"
            }
          >
            <span className="relative flex size-4 items-center justify-center">
              <svg
                viewBox="0 0 24 24"
                className="-rotate-90 absolute inset-0 size-full transform-gpu"
                aria-hidden="true"
              >
                <circle
                  cx="12"
                  cy="12"
                  r={radius}
                  fill="none"
                  stroke="color-mix(in oklab, var(--color-muted-foreground) 35%, transparent)"
                  strokeWidth="3"
                />
                <circle
                  cx="12"
                  cy="12"
                  r={radius}
                  fill="none"
                  stroke={usageColor}
                  strokeWidth="3"
                  strokeLinecap="round"
                  strokeDasharray={circumference}
                  strokeDashoffset={dashOffset}
                  className="transition-[stroke-dashoffset] duration-500 ease-out motion-reduce:transition-none"
                />
              </svg>
            </span>
          </button>
        }
      />
      <PopoverPopup tooltipStyle side="top" align="end" className="w-64 max-w-none p-0">
        {usage ? (
          <div className="flex flex-col gap-2 p-3">
            <div className="flex items-center justify-between gap-3">
              <div className="font-medium text-muted-foreground text-xs">Context Window</div>
              {usage.maxTokens !== null && usedPercentage ? (
                <div className="text-[11px] tabular-nums text-muted-foreground/70">
                  <span>{usedPercentage}</span>
                  <span className="mx-1">·</span>
                  <span>
                    {formatContextWindowTokens(usage.usedTokens)}/
                    {formatContextWindowTokens(usage.maxTokens ?? null)}
                  </span>
                </div>
              ) : (
                <div className="text-[11px] tabular-nums text-muted-foreground/70">
                  {formatContextWindowTokens(usage.usedTokens)}
                </div>
              )}
            </div>
            {usage.maxTokens !== null ? (
              <div
                className="h-1.5 w-full overflow-hidden rounded-full bg-muted/60"
                role="progressbar"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={Math.round(normalizedPercentage)}
                aria-label="Context window usage"
              >
                <div
                  className="h-full rounded-full transition-[width,background-color] duration-500 ease-out motion-reduce:transition-none"
                  style={{ width: `${normalizedPercentage}%`, backgroundColor: usageColor }}
                />
              </div>
            ) : null}
            {showTotalProcessed ? (
              <div className="flex items-center justify-between gap-3 text-[11px] leading-4">
                <span className="text-muted-foreground/60">Total processed</span>
                <span className="font-medium tabular-nums text-muted-foreground/80">
                  {formatContextWindowTokens(totalProcessedTokens)}
                </span>
              </div>
            ) : null}
            {usage.compactsAutomatically ? (
              <div className="mt-1 text-pretty text-[11px] font-medium text-muted-foreground/70">
                {providerDisplayName ?? "It"} automatically compacts its context when needed.
              </div>
            ) : null}
          </div>
        ) : null}
        {providerUsage ? (
          <ProviderUsageSection usage={providerUsage} divided={usage != null} />
        ) : null}
      </PopoverPopup>
    </Popover>
  );
}
