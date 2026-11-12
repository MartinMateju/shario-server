import mongoose from "mongoose";

export function createMockTenant(overrides = {}) {
  return {
    _id: new mongoose.Types.ObjectId(),
    slug: "test-studio",
    name: "Test Studio",
    ...overrides,
  };
}

export function createMockReq({ tenantId, userInfo = {}, body = {}, query = {}, params = {}, headers = {} } = {}) {
  return {
    tenantId,
    userInfo: {
      tenantId,
      ...userInfo,
    },
    body,
    query,
    params,
    headers,
  };
}
