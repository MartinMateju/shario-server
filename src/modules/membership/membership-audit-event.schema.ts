import mongoose, { Schema } from "mongoose";

export const membershipAuditEventSchema = new Schema(
  {
    tenant: { type: Schema.Types.ObjectId, ref: "Tenant", required: true, immutable: true },
    actor: { type: Schema.Types.ObjectId, ref: "User", default: null, immutable: true },
    user: { type: Schema.Types.ObjectId, ref: "User", default: null, immutable: true },
    membership: { type: Schema.Types.ObjectId, ref: "UserMembership", default: null, immutable: true },
    plan: { type: Schema.Types.ObjectId, ref: "MembershipPlan", default: null, immutable: true },
    type: { type: String, required: true, trim: true, maxlength: 100, immutable: true },
    source: {
      type: String,
      enum: ["owner", "customer", "webhook", "system", "migration"],
      required: true,
      immutable: true,
    },
    metadata: { type: Schema.Types.Mixed, default: {}, immutable: true },
  },
  { timestamps: { createdAt: true, updatedAt: false }, strict: true },
);

membershipAuditEventSchema.index({ tenant: 1, createdAt: -1 });
membershipAuditEventSchema.index({ membership: 1, createdAt: -1 });

type MembershipAuditEventRecord = mongoose.InferSchemaType<typeof membershipAuditEventSchema>;
export const MembershipAuditEventModel: mongoose.Model<MembershipAuditEventRecord> =
  (mongoose.models.MembershipAuditEvent as mongoose.Model<MembershipAuditEventRecord> | undefined) ??
  mongoose.model<MembershipAuditEventRecord>("MembershipAuditEvent", membershipAuditEventSchema);

export const recordMembershipAudit = async (input: {
  tenantId: string;
  actorId?: string | null;
  userId?: string | null;
  membershipId?: string | null;
  planId?: string | null;
  type: string;
  source: "owner" | "customer" | "webhook" | "system" | "migration";
  metadata?: Record<string, unknown>;
  session?: mongoose.ClientSession;
}) => MembershipAuditEventModel.create([{
  tenant: input.tenantId,
  actor: input.actorId || null,
  user: input.userId || null,
  membership: input.membershipId || null,
  plan: input.planId || null,
  type: input.type,
  source: input.source,
  metadata: input.metadata ?? {},
}], input.session ? { session: input.session } : undefined);

export default MembershipAuditEventModel;
