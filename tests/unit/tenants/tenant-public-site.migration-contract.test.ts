import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const migration = fs.readFileSync(
  path.join(
    process.cwd(),
    "src",
    "modules",
    "tenants",
    "scripts",
    "migrate-public-site-editor.ts",
  ),
  "utf8",
);

describe("public-site editor migration safety contract", () => {
  it("is opt-in, idempotent and compare-and-swaps the draft revision", () => {
    expect(migration).toContain('process.argv.includes("--apply")');
    expect(migration).toContain(
      '"publicSiteEditor.published": { $exists: false }',
    );
    expect(migration).toContain(
      '{ "publicSiteEditor.draftRevision": draftRevision }',
    );
    expect(migration).toContain(
      '{ "publicSiteEditor.draftRevision": 0 }',
    );
    expect(migration).toMatch(
      /"publicSiteEditor\.draftRevision":\s*\{\s*\$exists:\s*false/,
    );
    expect(migration).toContain(
      '"publicSiteEditor.publishedRevision": 0',
    );
    expect(migration).not.toContain("$unset");
    expect(migration).not.toContain("deleteMany");
  });

  it("seeds published from the public snapshot and preserves an existing draft", () => {
    expect(migration).toContain('snapshot: "published"');
    expect(migration).toContain('snapshot: "draft"');
    expect(migration).toContain('"publicSiteEditor.draft": draft');
    expect(migration).toContain('"publicSiteEditor.published": published');
    expect(migration).toContain("publicSite: published");
  });
});
