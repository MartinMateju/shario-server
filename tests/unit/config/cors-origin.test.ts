import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/modules/tenants/tenant.repository.js", () => ({
  findActiveTenantByHostname: vi.fn(),
}));

import {
  clearCorsCustomDomainCache,
  isCorsOriginAllowed,
} from "@/config/cors-origin.js";
import type { TenantDocument } from "@/modules/tenants/tenant.types.js";

const activeTenant = {} as TenantDocument;

describe("credentialed CORS origin authorization", () => {
  beforeEach(() => {
    clearCorsCustomDomainCache();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  it("allows the platform HTTPS origin without a tenant lookup", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const lookup = vi.fn();

    await expect(
      isCorsOriginAllowed("https://studio-olivka.shario.io", lookup),
    ).resolves.toBe(true);
    expect(lookup).not.toHaveBeenCalled();
  });

  it("allows an active custom HTTPS domain", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const lookup = vi.fn().mockResolvedValue(activeTenant);

    await expect(
      isCorsOriginAllowed("https://pottery.example", lookup),
    ).resolves.toBe(true);
    expect(lookup).toHaveBeenCalledWith("pottery.example");
  });

  it("denies an unknown custom domain", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const lookup = vi.fn().mockResolvedValue(null);

    await expect(
      isCorsOriginAllowed("https://unknown.example", lookup),
    ).resolves.toBe(false);
  });

  it("requires secure, standard-port custom origins in production", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const lookup = vi.fn().mockResolvedValue(activeTenant);

    await expect(
      isCorsOriginAllowed("http://pottery.example", lookup),
    ).resolves.toBe(false);
    await expect(
      isCorsOriginAllowed("https://pottery.example:8443", lookup),
    ).resolves.toBe(false);
    expect(lookup).not.toHaveBeenCalled();
  });

  it("caches active-domain decisions by normalized hostname", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const lookup = vi.fn().mockResolvedValue(activeTenant);

    await expect(
      isCorsOriginAllowed("https://Pottery.Example", lookup),
    ).resolves.toBe(true);
    await expect(
      isCorsOriginAllowed("https://pottery.example", lookup),
    ).resolves.toBe(true);
    expect(lookup).toHaveBeenCalledTimes(1);
  });

  it("coalesces concurrent lookups for the same custom hostname", async () => {
    vi.stubEnv("NODE_ENV", "production");
    let resolveLookup: ((tenant: TenantDocument | null) => void) | undefined;
    const lookup = vi.fn(
      () =>
        new Promise<TenantDocument | null>((resolve) => {
          resolveLookup = resolve;
        }),
    );

    const first = isCorsOriginAllowed("https://pottery.example", lookup);
    const second = isCorsOriginAllowed("https://POTTERY.EXAMPLE", lookup);

    expect(lookup).toHaveBeenCalledTimes(1);
    resolveLookup?.(activeTenant);

    await expect(Promise.all([first, second])).resolves.toEqual([true, true]);
  });

  it("fails closed instead of exceeding the custom-domain lookup limit", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const resolvers: Array<(tenant: TenantDocument | null) => void> = [];
    const lookup = vi.fn(
      () =>
        new Promise<TenantDocument | null>((resolve) => {
          resolvers.push(resolve);
        }),
    );
    const pending = Array.from({ length: 16 }, (_, index) =>
      isCorsOriginAllowed(`https://tenant-${index}.example`, lookup),
    );

    await expect(
      isCorsOriginAllowed("https://over-limit.example", lookup),
    ).resolves.toBe(false);
    expect(lookup).toHaveBeenCalledTimes(16);

    resolvers.forEach((resolve) => resolve(null));
    await expect(Promise.all(pending)).resolves.toEqual(
      Array.from({ length: 16 }, () => false),
    );
  });

  it("rate-limits sustained uncached custom-domain lookups", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-04T08:00:00.000Z"));
    clearCorsCustomDomainCache();
    vi.stubEnv("NODE_ENV", "production");
    const lookup = vi.fn().mockResolvedValue(null);

    for (let index = 0; index < 64; index += 1) {
      await isCorsOriginAllowed(`https://tenant-${index}.example`, lookup);
    }

    await expect(
      isCorsOriginAllowed("https://over-budget.example", lookup),
    ).resolves.toBe(false);
    expect(lookup).toHaveBeenCalledTimes(64);

    vi.advanceTimersByTime(1_001);
    await isCorsOriginAllowed("https://after-refill.example", lookup);
    expect(lookup).toHaveBeenCalledTimes(65);
  });

  it("expires cached custom-domain decisions", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-04T08:00:00.000Z"));
    vi.stubEnv("NODE_ENV", "production");
    const lookup = vi.fn().mockResolvedValue(activeTenant);

    await isCorsOriginAllowed("https://pottery.example", lookup);
    vi.advanceTimersByTime(60_001);
    await isCorsOriginAllowed("https://pottery.example", lookup);

    expect(lookup).toHaveBeenCalledTimes(2);
  });

  it("fails closed for malformed origins", async () => {
    const lookup = vi.fn();

    await expect(isCorsOriginAllowed("not an origin", lookup)).resolves.toBe(
      false,
    );
    expect(lookup).not.toHaveBeenCalled();
  });
});
