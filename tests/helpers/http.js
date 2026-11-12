export function createMockReq({ body = {}, query = {}, params = {}, userInfo = {}, tenant = null } = {}) {
  return { body, query, params, userInfo, tenant };
}

export function createMockRes() {
  const res = {};
  res.statusCode = 200;
  res.payload = undefined;
  res.status = (code) => {
    res.statusCode = code;
    return res;
  };
  res.json = (payload) => {
    res.payload = payload;
    return res;
  };
  return res;
}
