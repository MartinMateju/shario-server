import { z } from "zod";
import { createTeamMemberBaseSchema } from "./tenant-access.validators.js";

export const invitationLocaleSchema = z
  .object({ locale: z.enum(["cs", "en"]).default("en") })
  .strict();
export const createTeamInvitationSchema = createTeamMemberBaseSchema
  .safeExtend({ locale: z.enum(["cs", "en"]).default("en") })
  .transform(({ role, roleKey, ...value }) => ({
    ...value,
    roleKey: roleKey ?? role!,
  }));
export const invitationTokenSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
export const previewTeamInvitationSchema = z
  .object({ token: invitationTokenSchema })
  .strict();
export const acceptTeamInvitationSchema = z
  .object({
    token: invitationTokenSchema,
    password: z.string().min(1).max(128),
    firstname: z.string().trim().min(1).max(80).optional(),
    lastname: z.string().trim().min(1).max(80).optional(),
  })
  .strict();
export const newInvitationAccountSchema = z.object({
  password: z.string().min(8).max(128).regex(/\d/),
  firstname: z.string().trim().min(1).max(80),
  lastname: z.string().trim().min(1).max(80),
});
export type CreateTeamInvitationInput = z.infer<
  typeof createTeamInvitationSchema
>;
export type AcceptTeamInvitationInput = z.infer<
  typeof acceptTeamInvitationSchema
>;
