# Backend test toolkit

This folder is intentionally generic so it can support every backend module, not only bookings.

## Structure

```txt
tests/
  builders/      fluent builders for readable tests
  factories/     create DB records with valid defaults
  fixtures/      plain object fixtures without DB writes
  helpers/       Mongo, auth, HTTP mocks, ObjectId utilities
  unit/          fast pure logic tests
  integration/   Mongo/API/service integration tests
```

## Commands

```bash
npm run test
npm run test:unit
npm run test:integration
npm run test:coverage
```

## Recommended rule

Use fixtures for pure unit tests, builders for readable scenario setup, and factories only when a test needs MongoDB records.
