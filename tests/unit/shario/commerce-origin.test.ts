import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveTenantCommerceOrigin } from "@/modules/checkout/checkout.urls.js";

afterEach(() => vi.unstubAllEnvs());

describe("Shario local commerce links", () => {
  it("keeps email and checkout returns on the configured Shario frontend port", () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("CLIENT_URL", "http://shario.localhost:4310");
    vi.stubEnv("DEVELOPMENT_ROOT_DOMAIN", "shario.localhost");
    expect(resolveTenantCommerceOrigin({ tenant: { slug: "common-ground" } })).toBe("http://common-ground.shario.localhost:4310");
    expect(resolveTenantCommerceOrigin({ tenant: { slug: "common-ground" }, requestedOrigin: "https://untrusted.example" })).toBe("http://common-ground.shario.localhost:4310");
  });
});
