// Test-process boundary, installed before application modules (including dotenv).
const net = require('node:net');
const dns = require('node:dns');
const fs = require('node:fs');
const allowed = (host) => ['127.0.0.1', '::1', 'localhost'].includes(host) || String(host).endsWith('.shario.localhost');
const deny = (host) => {
  if (process.env.REHEARSAL_BLOCKED_FILE) fs.appendFileSync(process.env.REHEARSAL_BLOCKED_FILE, JSON.stringify({ host: String(host), pid: process.pid }) + '\n');
  throw new Error('Rollback rehearsal blocked non-loopback network destination: ' + host);
};
const connect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args) {
  const options = net._normalizeArgs(Array.isArray(args[0]) ? args[0] : args)[0];
  if (!options.path && !allowed(options.host || 'localhost')) deny(options.host);
  return connect.apply(this, args);
};
const lookup = dns.lookup;
dns.lookup = function (host, options, callback) {
  if (!allowed(host)) return deny(host);
  return lookup.call(this, String(host).endsWith('.shario.localhost') ? '127.0.0.1' : host, options, callback);
};
const listen = net.Server.prototype.listen;
net.Server.prototype.listen = function (...args) {
  if (typeof args[0] === 'number' && typeof args[1] !== 'string') args.splice(1, 0, '127.0.0.1');
  return listen.apply(this, args);
};
