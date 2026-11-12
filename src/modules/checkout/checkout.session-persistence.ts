type UpdateResult = {
  modifiedCount?: number;
};

type AttachStripeSessionOrExpireArgs = {
  sessionId: string;
  attach: () => Promise<UpdateResult>;
  expire: (sessionId: string) => Promise<unknown>;
};

type CreateDurableStripeCheckoutSessionArgs<TSession extends { id: string }> = {
  persistOrder: () => Promise<unknown>;
  validatePersistedOrder?: (persistedOrder: unknown) => void;
  createSession: () => Promise<TSession>;
  validateSession?: (session: TSession) => void;
  attach: (session: TSession) => Promise<UpdateResult>;
  expire: (sessionId: string) => Promise<unknown>;
};

/**
 * A Checkout Session URL must never escape unless its durable order points
 * back to it. If the atomic attachment fails, expire the unreachable Session
 * before propagating the persistence error.
 */
export const attachStripeSessionOrExpire = async ({
  sessionId,
  attach,
  expire,
}: AttachStripeSessionOrExpireArgs): Promise<void> => {
  try {
    const result = await attach();

    if (result.modifiedCount !== 1) {
      throw new Error(
        "Stripe Checkout Session could not be attached to its order.",
      );
    }
  } catch (persistenceError) {
    try {
      await expire(sessionId);
    } catch (expirationError) {
      throw new AggregateError(
        [persistenceError, expirationError],
        "Stripe Checkout Session persistence and expiration both failed.",
      );
    }

    throw persistenceError;
  }
};

export const createDurableStripeCheckoutSession = async <
  TSession extends { id: string },
>({
  persistOrder,
  validatePersistedOrder,
  createSession,
  validateSession,
  attach,
  expire,
}: CreateDurableStripeCheckoutSessionArgs<TSession>): Promise<TSession> => {
  const persistedOrder = await persistOrder();
  validatePersistedOrder?.(persistedOrder);

  const session = await createSession();
  validateSession?.(session);

  await attachStripeSessionOrExpire({
    sessionId: session.id,
    attach: () => attach(session),
    expire,
  });

  return session;
};
