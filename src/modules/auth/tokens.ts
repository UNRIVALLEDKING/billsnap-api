// TEMPORARY (demo only): stateless HS256 JWTs for the demo login.
// Phase A3 replaces this with Google/Apple sign-in and rotating DB-backed refresh sessions
// (SYSTEM_DESIGN section 4). Do not build on this module.
import { errors, jwtVerify, SignJWT } from "jose";
import { AppError, unauthenticated } from "../../platform/errors";

export const ACCESS_TTL_SECONDS = 12 * 60 * 60; // 12 h, demo convenience
export const REFRESH_TTL_SECONDS = 30 * 24 * 60 * 60;
const ISSUER = "billdrop-api";
const AUDIENCE = "billdrop-app";

export type TokenType = "access" | "refresh";

const key = (secret: string) => new TextEncoder().encode(secret);

export function signToken(
  secret: string,
  sub: string,
  typ: TokenType,
  ttlSeconds = typ === "access" ? ACCESS_TTL_SECONDS : REFRESH_TTL_SECONDS,
): Promise<string> {
  return new SignJWT({ typ })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(sub)
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setIssuedAt()
    .setExpirationTime(`${ttlSeconds}s`)
    .sign(key(secret));
}

/** Returns the subject. Expired access tokens raise token_expired; everything else unauthenticated. */
export async function verifyToken(secret: string, token: string, typ: TokenType): Promise<string> {
  try {
    const { payload } = await jwtVerify(token, key(secret), {
      algorithms: ["HS256"],
      issuer: ISSUER,
      audience: AUDIENCE,
      requiredClaims: ["sub", "iat", "exp"],
    });
    if (payload.typ !== typ || !payload.sub) throw unauthenticated("Invalid token");
    return payload.sub;
  } catch (err) {
    if (err instanceof AppError) throw err;
    if (err instanceof errors.JWTExpired && typ === "access") {
      throw new AppError("token_expired", 401, "Access token expired");
    }
    throw unauthenticated("Invalid token");
  }
}
