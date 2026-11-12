import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

// The Shario family is bundled under SIL OFL 1.1. Validate the exact static
// instances at install/build time; voucher rendering never needs a font CDN.
const directory = new URL("../assets/fonts/manrope/", import.meta.url);
const fonts = JSON.parse(
  await readFile(new URL("font-manifest.json", directory), "utf8"),
);
await Promise.all(
  fonts.map(async ({ name, sha256 }) => {
    if (!/^Manrope-(Regular|Semibold|Bold)\.ttf$/.test(name)) {
      throw new Error("Invalid bundled voucher font manifest entry.");
    }
    const bytes = await readFile(new URL(name, directory));
    const digest = createHash("sha256").update(bytes).digest("hex");
    if (digest !== sha256) {
      throw new Error(`Bundled voucher font integrity check failed: ${name}`);
    }
  }),
);
