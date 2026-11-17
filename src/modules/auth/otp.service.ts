import { randomInt, timingSafeEqual } from "node:crypto";
import { AppError } from "../../platform/errors";

const OTP_TTL_MS = 5 * 60 * 1000; // 5 minutes
const RESEND_COOLDOWN_MS = 30 * 1000; // 30 seconds
const MAX_VERIFY_ATTEMPTS = 3;
const MAX_SENDS_PER_HOUR = 10;
const RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000;

interface OtpEntry {
  code: string;
  expiresAt: number;
  resendAvailableAt: number;
  attempts: number;
}

interface RateLimitEntry {
  count: number;
  resetAt: number;
}

export class OtpService {
  private store = new Map<string, OtpEntry>();
  private rateLimits = new Map<string, RateLimitEntry>();

  private normalize(identifier: string): string {
    return identifier.trim().toLowerCase();
  }

  private safeCompare(a: string, b: string): boolean {
    if (a.length !== b.length) return false;
    const bufA = Buffer.from(a);
    const bufB = Buffer.from(b);
    return timingSafeEqual(bufA, bufB);
  }

  private checkRateLimit(key: string): void {
    const now = Date.now();
    let entry = this.rateLimits.get(key);
    if (!entry || entry.resetAt <= now) {
      entry = { count: 0, resetAt: now + RATE_LIMIT_WINDOW_MS };
      this.rateLimits.set(key, entry);
    }
    entry.count++;
    if (entry.count > MAX_SENDS_PER_HOUR) {
      const retryAfter = Math.max(1, Math.ceil((entry.resetAt - now) / 1000));
      throw new AppError("rate_limited", 429, "Too many OTP requests. Please try again later.", {
        "Retry-After": String(retryAfter),
      });
    }
  }

  generateCode(): string {
    return randomInt(100000, 1000000).toString();
  }

  sendOtp(
    identifier: string,
    ip: string,
  ): {
    status: "sent";
    identifier: string;
    expires_in: number;
    resend_in: number;
    debug_otp: string;
  } {
    const id = this.normalize(identifier);
    this.checkRateLimit(`id:${id}`);
    this.checkRateLimit(`ip:${ip}`);

    const now = Date.now();
    const existing = this.store.get(id);
    if (existing && existing.resendAvailableAt > now) {
      const waitSeconds = Math.ceil((existing.resendAvailableAt - now) / 1000);
      throw new AppError(
        "rate_limited",
        429,
        `Please wait ${waitSeconds}s before requesting a new code`,
        {
          "Retry-After": String(waitSeconds),
        },
      );
    }

    const code = this.generateCode();
    this.store.set(id, {
      code,
      expiresAt: now + OTP_TTL_MS,
      resendAvailableAt: now + RESEND_COOLDOWN_MS,
      attempts: 0,
    });

    return {
      status: "sent",
      identifier: id,
      expires_in: Math.floor(OTP_TTL_MS / 1000),
      resend_in: Math.floor(RESEND_COOLDOWN_MS / 1000),
      debug_otp: code,
    };
  }

  verifyOtp(identifier: string, code: string): boolean {
    const id = this.normalize(identifier);
    const entry = this.store.get(id);
    const now = Date.now();

    if (!entry || entry.expiresAt <= now) {
      this.store.delete(id);
      throw new AppError(
        "otp_expired",
        400,
        "The login code has expired. Please request a new one.",
      );
    }

    if (!this.safeCompare(entry.code, code.trim())) {
      entry.attempts++;
      if (entry.attempts >= MAX_VERIFY_ATTEMPTS) {
        this.store.delete(id);
        throw new AppError(
          "otp_locked",
          400,
          "Too many incorrect attempts. Please request a new code.",
        );
      }
      const remaining = MAX_VERIFY_ATTEMPTS - entry.attempts;
      throw new AppError("invalid_otp", 400, `Incorrect code. ${remaining} attempt(s) remaining.`);
    }

    // Success: consume OTP immediately
    this.store.delete(id);
    return true;
  }

  // Clear for tests
  clear(): void {
    this.store.clear();
    this.rateLimits.clear();
  }
}

export const defaultOtpService = new OtpService();
