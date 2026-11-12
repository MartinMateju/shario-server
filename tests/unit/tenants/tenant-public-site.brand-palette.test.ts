import { readdirSync, readFileSync } from "node:fs";
import { extname, join, relative } from "node:path";

import { describe, expect, it } from "vitest";

import {
  DEFAULT_PUBLIC_SITE_ACCENT_COLOR,
  DEFAULT_PUBLIC_SITE_BACKGROUND_COLOR,
  DEFAULT_PUBLIC_SITE_SECONDARY_COLOR,
  SHARIO_BRAND_COLORS,
} from "@/modules/tenants/public-site/tenant-public-site.constants.js";

const repositoryRoot = process.cwd();

const collectTypeScriptSources = (directory: string): string[] =>
  readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return collectTypeScriptSources(path);
    return [".ts", ".tsx"].includes(extname(entry.name)) ? [path] : [];
  });

describe("public-site brand palette contract", () => {
  it("uses the exact corporate palette for persisted public-site defaults", () => {
    expect(SHARIO_BRAND_COLORS).toEqual({
      PRIMARY: "#1F36D4",
      OFFSET: "#FCFBF8",
      ACCENT: "#D27357",
    });
    expect(DEFAULT_PUBLIC_SITE_ACCENT_COLOR).toBe(SHARIO_BRAND_COLORS.PRIMARY);
    expect(DEFAULT_PUBLIC_SITE_SECONDARY_COLOR).toBe(SHARIO_BRAND_COLORS.ACCENT);
    expect(DEFAULT_PUBLIC_SITE_BACKGROUND_COLOR).toBe(SHARIO_BRAND_COLORS.OFFSET);
  });

  it("contains no retired public-site defaults in production source", () => {
    const retiredColor =
      /#(?:3367d6|ed8467|f9eadc|e56f51)\b|rgba?\(\s*(?:51(?:\s+|,\s*)103(?:\s+|,\s*)214|237(?:\s+|,\s*)132(?:\s+|,\s*)103|249(?:\s+|,\s*)234(?:\s+|,\s*)220|229(?:\s+|,\s*)111(?:\s+|,\s*)81)\b/i;
    const offenders = collectTypeScriptSources(join(repositoryRoot, "src"))
      .filter((path) => retiredColor.test(readFileSync(path, "utf8")))
      .map((path) => relative(repositoryRoot, path));

    expect(offenders).toEqual([]);
  });
});
