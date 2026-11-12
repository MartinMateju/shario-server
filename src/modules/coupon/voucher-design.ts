import { z } from "zod";
import {
  DEFAULT_PUBLIC_SITE_FONT_PRESET,
  PUBLIC_SITE_FONT_PRESETS,
} from "@/modules/tenants/public-site/tenant-public-site.constants.js";

/** Keep saved v1 designs readable while sharing the website builder's presets. */
export const VOUCHER_DESIGN_FONTS = [
  ...PUBLIC_SITE_FONT_PRESETS,
  "sans",
  "serif",
  "mono",
] as const;

/** Deliberately bounded content: this is one print layout, not a free-form canvas. */
export const VOUCHER_DESIGN_LIMITS = {
  brandName: 60,
  title: 80,
  subtitle: 120,
  message: 400,
  footer: 160,
} as const;

const contentText = (maximum: number, required = false) =>
  z
    .string()
    .transform((value) => value.normalize("NFC").replace(/\r\n?/g, "\n").trim())
    .pipe(
      z
        .string()
        .min(required ? 1 : 0)
        .max(maximum)
        .refine(
          (value) =>
            !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/u.test(
              value,
            ),
          "Text contains unsupported control characters.",
        ),
    );

const color = z
  .string()
  .regex(/^#[0-9a-fA-F]{6}$/, "Use a six-digit hex color.")
  .transform((value) => value.toUpperCase());
const assetKey = z
  .string()
  .min(1)
  .max(500)
  .regex(/^[A-Za-z0-9][A-Za-z0-9_./-]*$/)
  .refine(
    (value) => !value.split("/").some((part) => part === "." || part === ".."),
    "Invalid asset path.",
  )
  .nullable();

export const voucherDesignSchema = z
  .object({
    version: z.literal(1),
    layout: z.literal("split"),
    colors: z
      .object({
        background: color,
        text: color,
        accent: color,
        // Older designs continue to inherit the general text color.
        title: color.optional(),
      })
      .strict(),
    typography: z
      .object({
        font: z.enum(VOUCHER_DESIGN_FONTS),
        titleWeight: z.enum(["regular", "bold"]),
      })
      .strict(),
    content: z
      .object({
        brandName: contentText(VOUCHER_DESIGN_LIMITS.brandName),
        title: contentText(VOUCHER_DESIGN_LIMITS.title, true),
        subtitle: contentText(VOUCHER_DESIGN_LIMITS.subtitle),
        message: contentText(VOUCHER_DESIGN_LIMITS.message),
        footer: contentText(VOUCHER_DESIGN_LIMITS.footer),
      })
      .strict(),
    assets: z.object({ logoKey: assetKey, imageKey: assetKey }).strict(),
    imageFit: z.enum(["cover", "contain"]),
  })
  .strict();

export type VoucherDesign = z.infer<typeof voucherDesignSchema>;

export const DEFAULT_VOUCHER_DESIGN: VoucherDesign = {
  version: 1,
  layout: "split",
  colors: { background: "#F5EEE6", text: "#242C28", accent: "#405747" },
  typography: { font: DEFAULT_PUBLIC_SITE_FONT_PRESET, titleWeight: "bold" },
  content: {
    brandName: "Your studio",
    title: "Gift voucher",
    subtitle: "A little time to create.",
    message: "Give someone space to make something of their own.",
    footer: "",
  },
  assets: { logoKey: null, imageKey: null },
  imageFit: "cover",
};

/** Parses a complete versioned design. Tenant defaults are resolved by the caller. */
export const normalizeVoucherDesign = (input: unknown): VoucherDesign =>
  voucherDesignSchema.parse(input);
