import { z } from "zod";

import {
  PORTAL_APPEARANCE_COLOR_KEYS,
  type PortalAppearanceColorKey,
} from "./portal-appearance.js";

const inheritablePortalColor = z
  .string()
  .trim()
  .regex(/^(?:|#[0-9a-f]{6})$/i)
  .transform((value) => value.toUpperCase());

export const portalAppearancePatchSchema = z
  .object(
    Object.fromEntries(
      PORTAL_APPEARANCE_COLOR_KEYS.map((key) => [
        key,
        inheritablePortalColor.optional(),
      ]),
    ) as Record<
      PortalAppearanceColorKey,
      z.ZodOptional<typeof inheritablePortalColor>
    >,
  )
  .strict()
  .refine((value) => Object.keys(value).length > 0, {
    message:
      "At least one customer-portal appearance setting must be provided.",
  });
