// Password hashing for email + password accounts: argon2id via Bun.password (salted, PHC-encoded string).

export const PASSWORD_MIN = 8;
export const PASSWORD_MAX = 128;

export function hashPassword(password: string): Promise<string> {
  return Bun.password.hash(password, { algorithm: "argon2id" });
}

/** False (never throws) for a malformed stored hash. */
export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  try {
    return await Bun.password.verify(password, hash);
  } catch {
    return false;
  }
}

let dummyHash: Promise<string> | undefined;

/**
 * Burns roughly one real verification when there is no account (or no password) for an email, so the
 * response time does not reveal whether the email is registered.
 */
export async function verifyAgainstDummy(password: string): Promise<void> {
  dummyHash ??= hashPassword("billsnap-dummy-password-never-matches");
  await verifyPassword(password, await dummyHash);
}
