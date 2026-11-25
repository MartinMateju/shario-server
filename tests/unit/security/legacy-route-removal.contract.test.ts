import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const read = (file: string) =>
  fs.readFileSync(path.join(process.cwd(), file), "utf8");

describe("removed legacy routes stay removed", () => {
  it("does not mount the legacy /metadata API (unscoped cross-tenant populate)", () => {
    const routes = read("src/app/routes.ts");

    expect(routes).not.toContain('"/metadata"');
    expect(routes).not.toContain("metadata.routes");
  });

  it("exposes no customer route that can rewrite a cart", () => {
    const cartRoutes = read("src/modules/cart/cart.routes.ts");

    expect(cartRoutes).not.toMatch(/router\.(patch|put|delete)\(/);
    expect(cartRoutes).not.toContain('"/items"');
    expect(cartRoutes).not.toContain('"/clear"');
    expect(cartRoutes).not.toContain("/convert");
    expect(cartRoutes.match(/router\.post\(/g)).toHaveLength(2);
  });
});
