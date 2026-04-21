import { isCancel, password, text } from "@clack/prompts";

export interface AdminCredentials {
  email: string;
  password: string;
}

/**
 * Admin account seeded on first install. Stored in the users table as
 * email + argon2id(password). Password is only held in memory inside
 * the wizard until it's written to the DB seeder stdin; nothing else
 * is persisted in the wizard process.
 */
export async function promptAdmin(): Promise<AdminCredentials | null> {
  const email = await text({
    message: "Admin email",
    placeholder: "you@example.com",
    validate: (v) =>
      /.+@.+\..+/.test(v.trim())
        ? undefined
        : "Looks like an invalid email — needs to be something@domain.tld",
  });
  if (isCancel(email)) return null;

  const pw = await password({
    message: "Admin password",
    validate: (v) =>
      v.length >= 8 ? undefined : "Please use at least 8 characters.",
  });
  if (isCancel(pw)) return null;

  const confirm = await password({
    message: "Confirm password",
    validate: (v) =>
      v === pw ? undefined : "Passwords don't match.",
  });
  if (isCancel(confirm)) return null;

  return { email: email.trim(), password: pw };
}
