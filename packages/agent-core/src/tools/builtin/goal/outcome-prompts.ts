import type { GoalCompletionGateVerdict, GoalSnapshot } from '../../../agent/goal';

export function buildGoalCompletionSummaryPrompt(goal: GoalSnapshot): string {
  return [
    buildGoalCompletionPromptMessage(goal),
    '',
    'Write a concise final message for the user. State that the goal is complete, summarize the main work completed, and mention any validation you ran. Do not call more goal tools.',
  ].join('\n');
}

/**
 * Model-facing output of a completion-gate rejection (C2 P2, §3.2/§3.5.1):
 * an ordinary tool error that keeps the goal active. It carries the
 * per-receipt failure reasons, the currently usable receipts (so the model
 * can re-cite without guessing ids), and the recovery path. Background task
 * completions never reach the evidence ledger (their results bypass
 * `finalizeToolResult`), so the guidance points at foreground verification.
 */
export function buildGoalCompletionGateRejectionPrompt(
  verdict: GoalCompletionGateVerdict,
): string {
  const lines: string[] = [
    'Goal not completed: the completion gate rejected this attempt. The goal is still active.',
  ];
  if (verdict.reason === 'no_evidence') {
    lines.push(
      'You did not cite any evidence. Call UpdateGoal with `complete` and `evidence` listing the ' +
        'tool call ids of verification results (for example, a passing test run) captured after ' +
        'your latest code change.',
    );
  } else {
    lines.push('Rejected evidence:');
    for (const rejection of verdict.rejections) {
      lines.push(`- ${rejection.reason}`);
    }
  }
  if (verdict.usableReceipts.length > 0) {
    lines.push('Currently usable receipts you may cite in `evidence`:');
    for (const receipt of verdict.usableReceipts) {
      lines.push(`- ${receipt.receiptId} (${receipt.toolName}: ${receipt.summary})`);
    }
  } else {
    lines.push('There are no usable receipts to cite yet.');
  }
  lines.push(
    'To proceed: run the verification again now as a foreground tool call (background task ' +
      'results are not recorded as evidence), then call UpdateGoal with `complete` and `evidence` ' +
      'citing the new tool call id. Evidence captured before your latest code change or older ' +
      'than the evidence lease is always rejected.',
  );
  return lines.join('\n');
}

export function buildGoalBlockedReasonPrompt(goal: GoalSnapshot): string {
  return [
    buildGoalBlockedMessage(goal),
    '',
    'Write a concise final message for the user. State that the goal is blocked, explain the concrete blocker, and say what input or change is needed before work can continue. Do not call more goal tools.',
  ].join('\n');
}

function buildGoalCompletionPromptMessage(goal: GoalSnapshot): string {
  const head = `Goal completed successfully${goal.terminalReason ? `: ${goal.terminalReason}` : ''}.`;
  const turns = `${goal.turnsUsed} turn${goal.turnsUsed === 1 ? '' : 's'}`;
  const stats = `Worked ${turns} over ${formatElapsed(goal.wallClockMs)}, using ${formatTokens(goal.tokensUsed)} tokens.`;
  return `${head}\n${stats}`;
}

function buildGoalBlockedMessage(goal: GoalSnapshot): string {
  const turns = `${goal.turnsUsed} turn${goal.turnsUsed === 1 ? '' : 's'}`;
  const stats = `Worked ${turns} over ${formatElapsed(goal.wallClockMs)}, using ${formatTokens(goal.tokensUsed)} tokens.`;
  return `Goal blocked.\n${stats}`;
}

function formatElapsed(ms: number): string {
  const totalSeconds = Math.round(ms / 1000);
  if (totalSeconds < 60) return `${String(totalSeconds)}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 60) return `${String(minutes)}m${seconds.toString().padStart(2, '0')}s`;
  const hours = Math.floor(minutes / 60);
  return `${String(hours)}h${(minutes % 60).toString().padStart(2, '0')}m`;
}

function formatTokens(tokens: number): string {
  if (tokens < 1000) return String(tokens);
  if (tokens < 1_000_000) return `${(tokens / 1000).toFixed(1)}k`;
  return `${(tokens / 1_000_000).toFixed(1)}M`;
}
