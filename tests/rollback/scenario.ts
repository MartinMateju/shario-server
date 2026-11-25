import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import mongoose from 'mongoose';
import Stripe from 'stripe';
import { buildAccessToken } from '@/modules/auth/auth.utils.js';
import Booking from '@/modules/booking/booking.model.js';
import User from '@/modules/user/user.model.js';
import { Order } from '@/modules/order/order.model.js';
import { MoneyCredit } from '@/modules/money-credit/money-credit.model.js';
import { CheckoutOperationModel } from '@/modules/checkout/checkout-operation.model.js';
import { BookingPaymentRefund } from '@/modules/booking/booking-payment-refund.model.js';
import { checkoutService } from '@/modules/checkout/services/checkout.service.js';
import { cancelBookingWithRefund } from '@/modules/booking/services/booking.refund.service.js';
import { CommunicationEmailLogModel } from '@/modules/communication-email-logs/communication-email-log.model.js';
import { RegisteredSenderEmailModel } from '@/modules/registered-sender-email/registered-sender-email.model.js';
import { encryptSecret } from '@/shared/security/encryption.js';
import { communicationEmailQueue, enqueueCommunicationEmail } from '@/infrastructure/queues/communication-email.queue.js';
import { dataImportQueue } from '@/infrastructure/queues/data-import.queue.js';

const tenant = '100000000000000000000001';
const customer = '200000000000000000000005';
const location = '300000000000000000000001';
const product = '400000000000000000000003';
const directory = process.env.REHEARSAL_DIRECTORY!;
const file = (name: string) => join(directory, name + '.json');
const read = (name: string) => JSON.parse(readFileSync(file(name), 'utf8'));
const save = (name: string, value: unknown) => writeFileSync(file(name), JSON.stringify(value, null, 2));
const phase = process.argv[2];
assert.equal(process.env.REHEARSAL_MODE, 'loopback-only');
assert.match(process.env.MONGO_URI || '', /^mongodb:\/\/127\.0\.0\.1:\d+\/shario-rollback-test-/);
assert.equal(process.env.REDIS_URL, 'redis://127.0.0.1:6379/15');
await mongoose.connect(process.env.MONGO_URI!);

const waitFor = async (check: () => Promise<boolean>, label: string) => {
  for (let i = 0; i < 120; i++) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`Timed out: ${label}`);
};
const request = async (key: string, day: number) => {
  const start = new Date(read('dates').start);
  start.setUTCDate(start.getUTCDate() + day);
  return { tenantId: tenant, user: (await User.findById(customer).lean())!, originUrl: 'http://studio-alpha.shario.localhost:4310', currency: 'EUR', locale: 'en', membershipDiscountEligible: false, idempotencyKey: key,
    cartItems: [{ product: { _id: new mongoose.Types.ObjectId(product), type: 'workshop', kind: 'open-studio', price: 0 }, locationId: new mongoose.Types.ObjectId(location), start: start.toISOString(), end: new Date(start.getTime() + 3600000).toISOString(), quantity: 1, numberOfGuests: 1, bookingMode: 'public', plannedActivity: 'SHARED_TABLE' }] } as any;
};
const deliver = async (checkout: any) => {
  const order = await Order.findById(checkout.orderId).lean();
  const event = { id: 'evt_rehearsal_paid_once', object: 'event', type: 'checkout.session.completed', account: 'acct_e2e_alpha_no_external_requests', livemode: false, created: Math.floor(Date.now() / 1000), data: { object: { id: checkout.sessionId, object: 'checkout.session', client_reference_id: String(checkout.orderId), status: 'complete', payment_status: 'paid', payment_intent: 'pi_rehearsal_paid_once', amount_total: order!.expectedAmountMinor, currency: 'eur', livemode: false, metadata: { sharioManaged: 'true', sharioFlow: 'order', orderId: String(checkout.orderId), tenantId: tenant } } } };
  const payload = JSON.stringify(event);
  const signature = Stripe.webhooks.generateTestHeaderString({ payload, secret: 'whsec_rehearsal' });
  const response = await fetch('http://127.0.0.1:4311/webhooks/stripe/connect', { method: 'POST', headers: { 'content-type': 'application/json', 'stripe-signature': signature }, body: payload });
  assert.equal(response.status, 200, await response.text());
};
const cancel = (bookingId: string) => cancelBookingWithRefund({ tenantId: tenant, userId: customer, bookingId });
const financialSnapshot = async () => ({
  balance: (await User.findById(customer).lean())!.moneyCreditsMinor,
  bookings: await Booking.find({ tenant, createdBy: customer }).select('_id status paymentStatus orders').sort({ _id: 1 }).lean(),
  orders: await Order.find({ tenant }).select('_id isPaid status paidAmountMinor expectedAmountMinor stripe.sessionId stripe.paymentIntentId stripe.processedEventIds').sort({ _id: 1 }).lean(),
  credits: await MoneyCredit.find({ tenant, user: customer }).select('_id transactions').lean(),
  operations: await CheckoutOperationModel.find({ tenant }).select('_id state kind keyHash requestHash orderId cartId response').sort({ _id: 1 }).lean(),
  cardRefundRecords: await BookingPaymentRefund.find({ tenant }).sort({ _id: 1 }).lean(),
});
const enqueueNotice = async (name: string) => {
  const booking = await Booking.findOne({ tenant, createdBy: customer, status: 'processed' }).lean();
  assert.ok(booking);
  const log = await CommunicationEmailLogModel.create({ tenant, user: customer, relatedEntityId: booking._id, relatedEntityType: 'booking', location, appliesToAllLocations: false, recipientEmail: 'booking-customer@studio-alpha.test', emailType: 'bookingRescheduled', purpose: 'transactional', allowanceClass: 'essential_system', subject: `Rollback rehearsal ${name}`, body: 'Local rollback rehearsal. No external delivery.', contentFormat: 'plain', locale: 'en', status: 'scheduled', scheduledFor: new Date(0), sourceScheduledAt: booking.start, deduplicationKey: name.padEnd(64, '0') });
  await enqueueCommunicationEmail({ tenantId: tenant, emailLogId: String(log._id) }, log.deduplicationKey!);
  save(name, { id: String(log._id), key: log.deduplicationKey });
};
const waitNotice = async (name: string) => {
  const { id } = read(name);
  await waitFor(async () => (await CommunicationEmailLogModel.findById(id).lean())?.status === 'sent', name);
  return (await CommunicationEmailLogModel.findById(id).lean())!;
};

try {
  if (phase === 'seed') {
    const { resetE2EFixtures } = await import('../e2e/support/e2e-fixtures.js');
    await resetE2EFixtures();
    const start = new Date(Date.now() + 14 * 86400000);
    start.setUTCHours(10, 0, 0, 0);
    save('dates', { start });
    await RegisteredSenderEmailModel.create({ tenant, createdBy: '200000000000000000000001', email: 'studio-alpha@notify.shario.io', displayName: 'Studio Alpha', replyToEmail: 'owner@studio-alpha.test', replyToVerifiedAt: new Date(), provider: 'postmark_managed', providerServerId: 900001, providerProvisionedAt: new Date(), providerProvisioningStatus: 'ready', encryptedPostmarkServerToken: encryptSecret('e2e-postmark-system-server-token'), isActive: true, isDefault: true });
  } else if (phase === 'candidate') {
    const checkout = await checkoutService.createStripeCheckout(await request('rehearsal-card-once', 0));
    save('checkout', checkout);
    await deliver(checkout);
    await deliver(checkout);
    const booked = await Booking.findOne({ tenant, createdBy: customer }).lean();
    assert.equal(booked?.paymentStatus, 'CONFIRMED');
    save('cancelled-booking', { id: String(booked!._id) });
    save('refund-result', await cancel(String(booked!._id)));
    await checkoutService.checkoutWithCredits(await request('rehearsal-credit-once', 1));
    await enqueueNotice('candidate-delivery');
    const delivered = await waitNotice('candidate-delivery');
    save('sent-history', { id: String(delivered._id), providerMessageId: delivered.providerMessageId, attempts: delivered.attempts, sentAt: delivered.sentAt });
    const financial = await financialSnapshot();
    const refunds = financial.credits.flatMap((ledger) => ledger.transactions).filter((transaction) => transaction.type === 'refund');
    assert.equal(refunds.length, 1);
    assert.equal(String(refunds[0].relatedBooking), String(booked!._id));
    assert.equal(refunds[0].amountMinor, financial.orders.find((order) => String(order._id) === String(checkout.orderId))!.paidAmountMinor);
    assert.equal(financial.operations.length, 2);
    assert.ok(financial.operations.every((operation) => operation.state === 'completed' && operation.keyHash && operation.requestHash && operation.response));
    assert.ok(financial.orders.some((order) => order.stripe?.processedEventIds.includes('evt_rehearsal_paid_once')));
    save('financial-before', financial);
  } else if (phase === 'queue-during-outage') {
    await enqueueNotice('rollback-delivery');
    // Replay a terminal import: the real importer must claim no new work.
    const sessionId = '720000000000000000000001';
    await mongoose.connection.collection('dataimportsessions').insertOne({ _id: new mongoose.Types.ObjectId(sessionId), tenant: new mongoose.Types.ObjectId(tenant), status: 'completed', createdBy: new mongoose.Types.ObjectId('200000000000000000000001'), entityType: 'customers' });
    await dataImportQueue.add('execute', { tenantId: tenant, sessionId, entityType: 'customers', operation: 'import' }, { jobId: 'rehearsal-terminal-import-replay' });
    assert.equal((await CommunicationEmailLogModel.findById(read('rollback-delivery').id).lean())!.status, 'scheduled');
  } else if (phase === 'verify') {
    await deliver(read('checkout'));
    const replay = await checkoutService.createStripeCheckout(await request('rehearsal-card-once', 0));
    assert.equal(String(replay.orderId), String(read('checkout').orderId));
    await checkoutService.checkoutWithCredits(await request('rehearsal-credit-once', 1));
    await assert.rejects(cancel(read('cancelled-booking').id), /already cancelled/);
    assert.deepEqual(JSON.parse(JSON.stringify(await financialSnapshot())), read('financial-before'));
    const activeBooking = await Booking.findOne({ tenant, createdBy: customer, status: 'processed' }).lean();
    assert.ok(activeBooking);
    const customerUser = (await User.findById(customer).lean())!;
    const token = buildAccessToken(customerUser as any, null, null, 'customer');
    const response = await fetch(`http://127.0.0.1:4311/bookings/mine/${activeBooking._id}`, { headers: { host: 'studio-alpha.shario.localhost:4311', authorization: `Bearer ${token}` } });
    const restoredBooking = await response.json() as any;
    assert.equal(response.status, 200, JSON.stringify(restoredBooking));
    assert.equal(restoredBooking.booking.id, String(activeBooking._id));
    assert.equal(restoredBooking.booking.paymentStatus, 'CONFIRMED');
    save('restored-customer-booking', restoredBooking);
    const sent = await waitNotice('candidate-delivery');
    assert.deepEqual(JSON.parse(JSON.stringify({ id: String(sent._id), providerMessageId: sent.providerMessageId, attempts: sent.attempts, sentAt: sent.sentAt })), read('sent-history'));
    await waitNotice('rollback-delivery');
    // Actually replay a delivered BullMQ job across the version boundary.
    const original = read('candidate-delivery');
    const queued = await enqueueCommunicationEmail({ tenantId: tenant, emailLogId: original.id }, original.key, { allowCompletedRetry: true });
    await waitFor(async () => (await queued.job.getState()) === 'completed', 'delivered job replay');
    await waitFor(async () => (await dataImportQueue.getJob('rehearsal-terminal-import-replay'))?.getState().then((state) => state === 'completed') ?? false, 'import replay');
    const imported = await dataImportQueue.getJob('rehearsal-terminal-import-replay');
    assert.deepEqual(imported?.returnvalue, { skipped: true, reason: 'not_claimable' });
    const resumed = await waitNotice('rollback-delivery');
    save('verification', { financialRecordsPreserved: true, duplicateSignedPaymentIgnored: true, checkoutIdempotencyPreserved: true, refundReplayRejected: true, authenticatedCustomerBookingRead: true, sentDeliveryPreserved: true, queuedEmailResumed: true, sentEmailReplayCompleted: true, terminalImportReplaySkipped: true, resumedMessageId: resumed.providerMessageId });
  } else throw new Error('Unknown scenario phase.');
  console.log(JSON.stringify({ event: 'rollback-scenario-complete', phase }));
} finally {
  await Promise.allSettled([communicationEmailQueue.close(), dataImportQueue.close(), mongoose.disconnect()]);
}
process.exit(0);
