# Access Codes Module

Production-ready replacement for the legacy `Code` + `CodeMessage` models.

## Renames

- `Code` -> `AccessCode`
- `CodeMessage` -> `AccessCodeNotification`
- `sendOutCodes()` -> `accessCodeNotificationService.run()`
- `sendUpcomingBookingReminders()` -> `accessCodeReminderService.sendUpcomingCourseReminders()`
- `markBookingsAsDelivered()` -> `bookingStatusService.markProcessedBookingsAsDelivered()`

## Files

```txt
access_codes/
├── access-code.constants.ts
├── access-code.model.ts
├── access-code.queries.ts
├── access-code.repository.ts
├── access-code.schema.ts
├── access-code.types.ts
├── access-code.utils.ts
├── access-code.validators.ts
├── controllers/
├── routes/
└── services/
```

## Notes

- Uses tenant-aware indexes and queries.
- Stores `location` only as a `Location` ObjectId and accepts `locationId` in
  API payloads and filters.
- Uses Zod for request validation.
- Uses Pino via your shared logger.
- Keeps email/SMS behind service adapters.
- Does not include a root `index.ts`, matching your preferred backend convention.
- You should migrate legacy collection names/data intentionally if you already have production `codes` and `codemessages` collections.

## Integration

Add the router in your startup routes:

```ts
import { accessCodeRouter } from "../../src/modules/access_codes/routes/access-code.routes.js";

apiRouter.use("/access-codes", accessCodeRouter);
```

Add cron calls in your server startup:

```ts
void runSafely("accessCodeNotificationService.run", () =>
  accessCodeNotificationService.run(),
);

void runSafely("accessCodeReminderService.sendUpcomingCourseReminders", () =>
  accessCodeReminderService.sendUpcomingCourseReminders(),
);

void runSafely("bookingStatusService.markProcessedBookingsAsDelivered", () =>
  bookingStatusService.markProcessedBookingsAsDelivered(),
);
```
