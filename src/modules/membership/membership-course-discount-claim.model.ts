import mongoose from "mongoose";

const schema = new mongoose.Schema({
  // Deterministic primary key enforces uniqueness even before secondary indexes
  // are built. An event gives a member at most one discounted place.
  _id: { type: String, required: true },
  tenant: { type: mongoose.Schema.Types.ObjectId, required: true },
  user: { type: mongoose.Schema.Types.ObjectId, required: true },
  booking: { type: mongoose.Schema.Types.ObjectId, required: true },
  order: { type: mongoose.Schema.Types.ObjectId, required: true },
}, { timestamps: true });
schema.index({ tenant: 1, user: 1, booking: 1 }, { unique: true });
schema.index({ tenant: 1, order: 1 });
const MembershipCourseDiscountClaim: mongoose.Model<any> =
  mongoose.models.MembershipCourseDiscountClaim || mongoose.model("MembershipCourseDiscountClaim", schema);
export default MembershipCourseDiscountClaim;
