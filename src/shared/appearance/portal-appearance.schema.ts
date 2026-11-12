import { Schema } from "mongoose";

import {
  PORTAL_APPEARANCE_COLOR_KEYS,
  type PortalAppearance,
} from "./portal-appearance.js";

export const portalAppearanceSchema = new Schema<PortalAppearance>(
  Object.fromEntries(
    PORTAL_APPEARANCE_COLOR_KEYS.map((key) => [
      key,
      {
        type: String,
        trim: true,
        uppercase: true,
        default: "",
        match: /^(?:|#[0-9A-F]{6})$/,
      },
    ]),
  ),
  { _id: false },
);
