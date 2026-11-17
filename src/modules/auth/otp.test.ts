import { describe, expect, test } from "bun:test";
import { AppError } from "../../platform/errors";
import { OtpService } from "./otp.service";

describe("OtpService", () => {
  test("generates 6-digit numeric code", () => {
    const service = new OtpService();
    const result = service.sendOtp("test@example.com", "1.1.1.1");
    expect(result.status).toBe("sent");
    expect(result.identifier).toBe("test@example.com");
    expect(result.debug_otp).toMatch(/^\d{6}$/);
    expect(result.expires_in).toBe(300);
    expect(result.resend_in).toBe(30);
  });

  test("normalizes identifier (trim and lowercase)", () => {
    const service = new OtpService();
    const result = service.sendOtp("  Test@Example.COM  ", "1.1.1.1");
    expect(result.identifier).toBe("test@example.com");
    expect(service.verifyOtp("TEST@example.com", result.debug_otp)).toBe(true);
  });

  test("enforces 30-second resend cooldown", () => {
    const service = new OtpService();
    service.sendOtp("cooldown@example.com", "1.1.1.1");
    expect(() => service.sendOtp("cooldown@example.com", "1.1.1.1")).toThrow(AppError);
    try {
      service.sendOtp("cooldown@example.com", "1.1.1.1");
    } catch (err) {
      expect((err as AppError).code).toBe("rate_limited");
      expect((err as AppError).status).toBe(429);
      expect((err as AppError).headers["Retry-After"]).toBeDefined();
    }
  });

  test("verifies correct code and consumes it (single-use)", () => {
    const service = new OtpService();
    const { debug_otp } = service.sendOtp("verify@example.com", "1.1.1.1");
    expect(service.verifyOtp("verify@example.com", debug_otp)).toBe(true);
    // Second attempt should fail as code is already consumed
    expect(() => service.verifyOtp("verify@example.com", debug_otp)).toThrow(AppError);
  });

  test("tracks wrong attempts and locks out after 3 failures", () => {
    const service = new OtpService();
    const { debug_otp } = service.sendOtp("attempts@example.com", "1.1.1.1");

    // Attempt 1: wrong
    try {
      service.verifyOtp("attempts@example.com", "000000");
    } catch (err) {
      expect((err as AppError).code).toBe("invalid_otp");
      expect((err as AppError).message).toContain("2 attempt(s) remaining");
    }

    // Attempt 2: wrong
    try {
      service.verifyOtp("attempts@example.com", "111111");
    } catch (err) {
      expect((err as AppError).code).toBe("invalid_otp");
      expect((err as AppError).message).toContain("1 attempt(s) remaining");
    }

    // Attempt 3: lockout
    try {
      service.verifyOtp("attempts@example.com", "222222");
    } catch (err) {
      expect((err as AppError).code).toBe("otp_locked");
    }

    // Even if user now provides the right code, it should be expired/locked
    expect(() => service.verifyOtp("attempts@example.com", debug_otp)).toThrow();
  });

  test("rejects expired or non-existent code", () => {
    const service = new OtpService();
    expect(() => service.verifyOtp("ghost@example.com", "123456")).toThrow(AppError);
  });
});
