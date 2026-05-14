import type postgres from "postgres";
import type { OAuthLoginStateStore } from "../../ports/oauth-login-state-store.js";
import {
  LoginState,
  type OAuthLoginState,
} from "../../domain/oauth-login-state.js";

type Sql = postgres.Sql<Record<string, unknown>>;

interface Row {
  state: string;
  code_verifier: string;
  redirect_path: string | null;
  created_at: Date | string;
  expires_at: Date | string;
  used_at: Date | string | null;
}

function toAttempt(r: Row): OAuthLoginState {
  return {
    state: LoginState(r.state),
    codeVerifier: r.code_verifier,
    redirectPath: r.redirect_path,
    createdAt: new Date(r.created_at),
    expiresAt: new Date(r.expires_at),
    usedAt: r.used_at ? new Date(r.used_at) : null,
  };
}

export class PostgresOAuthLoginStateStore implements OAuthLoginStateStore {
  constructor(private readonly sql: Sql) {}

  async put(attempt: OAuthLoginState): Promise<void> {
    await this.sql`
      INSERT INTO oauth_login_states
        (state, code_verifier, redirect_path, created_at, expires_at, used_at)
      VALUES
        (${attempt.state}, ${attempt.codeVerifier}, ${attempt.redirectPath},
         ${attempt.createdAt}, ${attempt.expiresAt}, ${attempt.usedAt})
    `;
  }

  /**
   * Atomic single-use consume. Returns the row's prior shape (with
   * `usedAt` set to the current time) only when the row existed AND
   * had not yet been consumed. A replay returns null.
   */
  async consume(state: LoginState): Promise<OAuthLoginState | null> {
    const rows = await this.sql<Row[]>`
      UPDATE oauth_login_states
         SET used_at = now()
       WHERE state = ${state}
         AND used_at IS NULL
       RETURNING state, code_verifier, redirect_path,
                 created_at, expires_at, used_at
    `;
    return rows[0] ? toAttempt(rows[0]) : null;
  }
}
