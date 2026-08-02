/**
 * Account snapshot — a network-free, read-only view of what the credential
 * store holds for a provider, built for status surfaces (the /status dialog).
 *
 * State mapping (from the TokenState classification):
 *   • missing → 'not-logged-in'  (no credential file)
 *   • revoked → 'expired'        (tombstone: the stored refresh_token was
 *                                 rejected; re-login required)
 *   • valid   → 'logged-in'
 *
 * ChatGPT Codex snapshots additionally carry the account claims parsed from
 * the stored id_token (email / plan type / account id) — the same claims
 * source codex-rs uses for its /status account row
 * (codex-rs/login/src/token_data.rs). Kimi tokens carry no account claims,
 * so their snapshots report the login state only.
 */

import { parseChatGptIdTokenClaims } from './chatgpt-codex-flow';
import type { TokenState } from './token-state';

export type OAuthAccountState = 'logged-in' | 'expired' | 'not-logged-in';

export interface OAuthAccountSnapshot {
  readonly state: OAuthAccountState;
  /** ChatGPT Codex only: `email` claim of the stored id_token, when present. */
  readonly email?: string | undefined;
  /** ChatGPT Codex only: `chatgpt_plan_type` claim (free/plus/pro/…). */
  readonly planType?: string | undefined;
  /** ChatGPT Codex only: `chatgpt_account_id` claim. */
  readonly accountId?: string | undefined;
}

/** Login-state-only snapshot (Kimi providers). Package-internal. */
export function accountSnapshotFromTokenState(state: TokenState): OAuthAccountSnapshot {
  switch (state.kind) {
    case 'missing':
      return { state: 'not-logged-in' };
    case 'revoked':
      return { state: 'expired' };
    case 'valid':
      return { state: 'logged-in' };
  }
}

/**
 * ChatGPT Codex snapshot: login state + id_token claims. Claims are optional
 * — a token stored before the id_token was kept (or one whose JWT carries no
 * email) still reports 'logged-in', just without the fields.
 * Package-internal.
 */
export function chatGptAccountSnapshotFromTokenState(state: TokenState): OAuthAccountSnapshot {
  if (state.kind !== 'valid') return accountSnapshotFromTokenState(state);
  const claims =
    state.token.idToken === undefined ? {} : parseChatGptIdTokenClaims(state.token.idToken);
  return {
    state: 'logged-in',
    email: claims.email,
    planType: claims.planType,
    accountId: claims.accountId ?? state.token.accountId,
  };
}
