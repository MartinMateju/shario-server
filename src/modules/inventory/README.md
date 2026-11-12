# Inventory module

Tenant- and location-scoped inventory for studio supplies.

## Canonical stock model

`InventoryItem.stockLevels` is the source of truth:

```ts
[
  {
    location: ObjectId,
    currentQuantity: number,
    minimumQuantity: number,
  },
]
```

`locations`, `currentQuantity`, and `minimumQuantity` remain synchronized
compatibility fields. `currentQuantity` and `minimumQuantity` are totals across
all canonical levels; they must not be used to decide whether a particular
location is low on stock.

All stock changes after item creation use an immutable movement record and the
item update in one MongoDB transaction. Transfers use one movement with source
`location` and `destinationLocation`. Stocktake completion and reorder receipt
are also transactional and idempotent.

`minimumQuantity = 0` disables automatic low-stock requests for that level.

## Reorder lifecycle

The supported lifecycle is:

`open -> ordered -> received`

An `open` or `ordered` request can instead become `cancelled`. `received` and
`cancelled` are terminal. Receiving creates an `in` movement and then stores
its ID as `receivedMovement`, allowing retries to prove that stock was already
applied.

## Legacy migration

Run the dry run before deploying the new unique open-reorder index:

```bash
npm run migration:inventory-stock-levels
```

Review the multi-location assignments and all manual-review samples, then:

```bash
npm run migration:inventory-stock-levels -- --apply
```

Rules:

- A one-location legacy balance moves exactly to that location.
- A multi-location legacy balance moves to the first stored location and all
  other levels start at zero. The dry run reports every such assignment.
- A locationless item with non-zero stock or threshold requires manual review;
  the migration never guesses its location.
- A zero-balance locationless item may use the tenant's active primary
  location.
- Duplicate open reorder rows are reconciled before the partial unique index.
- Legacy `received` reorders without `receivedMovement` are reported for
  manual review and are never automatically replayed, because replay could
  duplicate stock.
