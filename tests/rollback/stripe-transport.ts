import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import Stripe from 'stripe';

if (process.env.REHEARSAL_MODE !== 'loopback-only' || process.env.STRIPE_KEY !== 'sk_test_rehearsal_no_external_requests') throw new Error('Unsafe rehearsal transport environment.');
const directory = process.env.REHEARSAL_DIRECTORY!;
const prototype = Object.getPrototypeOf(Stripe.createNodeHttpClient());
prototype.makeRequest = async (host: string, _port: number, path: string, method: string, _headers: unknown, data: string) => {
  if (host !== 'api.stripe.com') throw new Error('Unexpected provider host.');
  let body: any;
  if (method === 'GET' && path === '/v1/accounts/acct_e2e_alpha_no_external_requests') {
    body = { id: 'acct_e2e_alpha_no_external_requests', object: 'account', country: 'CZ', default_currency: 'eur', details_submitted: true, charges_enabled: true, payouts_enabled: true, livemode: false, requirements: { currently_due: [], eventually_due: [], past_due: [], pending_verification: [] }, controller: { fees: { payer: 'account' }, losses: { payments: 'stripe' }, requirement_collection: 'stripe', stripe_dashboard: { type: 'full' } } };
  } else if (method === 'POST' && path === '/v1/checkout/sessions') {
    appendFileSync(join(directory, 'stripe-checkout-requests.jsonl'), JSON.stringify({ method, path }) + '\n');
    const input = new URLSearchParams(data);
    const orderId = input.get('client_reference_id');
    if (!/^[a-f0-9]{24}$/.test(orderId || '')) throw new Error('Unexpected checkout fixture.');
    const id = `cs_rehearsal_${orderId}`;
    const file = join(directory, `${id}.json`);
    if (existsSync(file)) body = JSON.parse(readFileSync(file, 'utf8'));
    else {
      const metadata = Object.fromEntries([...input.entries()].filter(([key]) => key.startsWith('metadata[')).map(([key, value]) => [key.slice(9, -1), value]));
      body = { id, object: 'checkout.session', url: `http://127.0.0.1:4100/fake-checkout/${id}`, status: 'open', payment_status: 'unpaid', livemode: false, expires_at: Number(input.get('expires_at')), metadata, currency: input.get('line_items[0][price_data][currency]'), amount_total: Number(metadata.expectedAmountMinor), client_reference_id: orderId };
      writeFileSync(file, JSON.stringify(body));
      appendFileSync(join(directory, 'stripe-actions.jsonl'), JSON.stringify({ action: 'checkout.created', id }) + '\n');
    }
  } else if (method === 'GET' && /^\/v1\/checkout\/sessions\/cs_rehearsal_[a-f0-9]{24}$/.test(path)) {
    body = JSON.parse(readFileSync(join(directory, `${path.split('/').at(-1)}.json`), 'utf8'));
  } else throw new Error(`Unconfigured Stripe request blocked: ${method} ${path}`);
  const headers = { 'content-type': 'application/json', 'request-id': 'req_rehearsal' };
  return { getStatusCode: () => 200, getHeaders: () => headers, getRawResponse: () => ({ statusCode: 200, headers }), toJSON: async () => body, toStream: () => { throw new Error('No streaming fixture.'); } };
};
