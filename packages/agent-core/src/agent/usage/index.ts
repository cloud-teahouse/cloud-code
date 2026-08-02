import type { UsageStatus } from '#/rpc';
import { addUsage, type RateLimitSnapshot, type TokenUsage } from '@cloud-code/kosong';

import type { Agent } from '..';

export type UsageRecordScope = 'session' | 'turn';

function copyUsage(usage: TokenUsage): TokenUsage {
  return { ...usage };
}

export class UsageRecorder {
  private readonly byModel: Record<string, TokenUsage> = {};
  private currentTurn: TokenUsage | undefined;
  /**
   * Latest rate-limit snapshot captured from provider response headers
   * (ChatGPT Codex `x-codex-*` family, official chatgpt.com backend only).
   * Persisted latest-wins as `usage.rate_limit` wire records and restored
   * on resume, so `/usage` shows the last known snapshot immediately (the
   * panel marks it stale as it ages) instead of staying empty until the
   * first post-resume response.
   */
  private latestRateLimit: RateLimitSnapshot | undefined;

  constructor(protected readonly agent?: Agent) {}

  beginTurn(): void {
    this.currentTurn = undefined;
  }

  endTurn(): void {
    this.currentTurn = undefined;
  }

  record(model: string, usage: TokenUsage, scope: UsageRecordScope = 'session'): void {
    this.agent?.records.logRecord({
      type: 'usage.record',
      model,
      usage,
      usageScope: scope,
    });
    // A settled request's usage is where prefix-drift attribution meets the
    // real cache counters (F7 diagnostics; self-gated on the debug switch).
    this.agent?.llmRequestRecorder.reportUsageSettled(usage);
    const current = this.byModel[model];
    this.byModel[model] = current === undefined ? copyUsage(usage) : addUsage(current, usage);

    if (scope === 'turn') {
      this.currentTurn =
        this.currentTurn === undefined ? copyUsage(usage) : addUsage(this.currentTurn, usage);
    }
    this.agent?.emitStatusUpdated();
  }

  recordRateLimit(snapshot: RateLimitSnapshot): void {
    this.latestRateLimit = snapshot;
    // Persist latest-wins so a resumed session restores the last known quota
    // state. Replay routes through this same method; logRecord is a no-op
    // while restoring, so restore never re-writes the record.
    this.agent?.records.logRecord({ type: 'usage.rate_limit', snapshot });
  }

  data(): UsageStatus {
    const byModel = this.byModelSnapshot();
    const hasByModel = Object.keys(byModel).length > 0;
    const currentTurn = this.currentTurn;
    return {
      byModel: hasByModel ? byModel : undefined,
      total: hasByModel ? totalUsage(byModel) : undefined,
      currentTurn: currentTurn === undefined ? undefined : copyUsage(currentTurn),
      rateLimit: this.latestRateLimit,
    };
  }

  status(): UsageStatus | undefined {
    const status = this.data();
    if (
      status.byModel === undefined &&
      status.total === undefined &&
      status.currentTurn === undefined &&
      status.rateLimit === undefined
    ) {
      return undefined;
    }
    return status;
  }

  private byModelSnapshot(): Record<string, TokenUsage> {
    return Object.fromEntries(
      Object.entries(this.byModel).map(([model, usage]) => [model, copyUsage(usage)]),
    );
  }
}

function totalUsage(byModel: Record<string, TokenUsage>): TokenUsage | undefined {
  let total: TokenUsage | undefined;
  for (const usage of Object.values(byModel)) {
    total = total === undefined ? copyUsage(usage) : addUsage(total, usage);
  }
  return total;
}
