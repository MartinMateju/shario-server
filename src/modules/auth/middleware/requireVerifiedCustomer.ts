import { createCustomerAccountGate } from "./requireCustomerAccount.js";

/** Keep email verification for workflows that explicitly require it. */
export const requireVerifiedCustomer = createCustomerAccountGate({
  requireEmailVerification: true,
});

export default requireVerifiedCustomer;
