// Domain
export * from "./domain/auth-profile.js";
export * from "./domain/auth-session.js";
export * from "./domain/errors.js";
export * from "./domain/platform-admin.js";
export * from "./domain/user.js";
export * from "./domain/person.js";
export * from "./domain/link-attempt.js";

// Ports
export type { AuthProvider } from "./ports/auth-provider.js";
export type { UserRepository } from "./ports/user-repository.js";
export type { SessionTokenizer } from "./ports/session-tokenizer.js";
export type { PersonRepository } from "./ports/person-repository.js";
export type { LinkAttemptStore } from "./ports/link-attempt-store.js";
export type { PasswordCredentialStore } from "./ports/password-credential-store.js";
export type { AccessGate } from "./ports/access-gate.js";
export { denyAllAccessGate } from "./ports/access-gate.js";

// Application
export * from "./application/sign-in.js";
export * from "./application/sign-in-with-password.js";
export * from "./application/verify-session.js";
export * from "./application/begin-link.js";
export * from "./application/complete-link.js";

// Adapters
export { GoogleAuthProvider } from "./adapters/google/google-auth-provider.js";
export { DevBypassAuthProvider } from "./adapters/dev-bypass/dev-bypass-auth-provider.js";
export { JwtSessionTokenizer } from "./adapters/jwt/jwt-session-tokenizer.js";
export { PostgresUserRepository } from "./adapters/postgres/postgres-user-repository.js";
export { PostgresPersonRepository } from "./adapters/postgres/postgres-person-repository.js";
export { PostgresLinkAttemptStore } from "./adapters/postgres/postgres-link-attempt-store.js";
export { PostgresPasswordCredentialStore } from "./adapters/postgres/postgres-password-credential-store.js";
export { PostgresAccessGate } from "./adapters/postgres/postgres-access-gate.js";
export { createAuthRoutes } from "./adapters/hono/routes.js";
export { createRequireAuth } from "./adapters/hono/require-auth.js";
