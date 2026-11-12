import mongoose from "mongoose";

import { passwordResetSchema } from "./password-reset.schema.js";
import type { PasswordReset as PasswordResetAttributes } from "./password-reset.types.js";

export const PasswordReset =
  (mongoose.models.PasswordReset as
    | mongoose.Model<PasswordResetAttributes>
    | undefined) ??
  mongoose.model<PasswordResetAttributes>(
    "PasswordReset",
    passwordResetSchema,
  );

export default PasswordReset;