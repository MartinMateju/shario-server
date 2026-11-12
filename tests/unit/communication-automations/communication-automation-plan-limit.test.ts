import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../..",
);
const readSource = (relativePath: string): string =>
  fs.readFileSync(path.join(repositoryRoot, relativePath), "utf8");

describe("communication automation plan-slot allocation", () => {
  it("serializes the limit check and create in one tenant transaction", () => {
    const source = readSource(
      "src/modules/communication-automations/services/communication-automation.service.ts",
    );
    const transactionStart = source.indexOf("session.withTransaction");
    const tenantLock = source.indexOf(
      "TenantModel.findOneAndUpdate",
      transactionStart,
    );
    const limitCheck = source.indexOf('"create_definition"', transactionStart);
    const create = source.indexOf(
      "communicationAutomationRepository.create",
      limitCheck,
    );

    expect(transactionStart).toBeGreaterThan(-1);
    expect(tenantLock).toBeGreaterThan(transactionStart);
    expect(limitCheck).toBeGreaterThan(tenantLock);
    expect(create).toBeGreaterThan(limitCheck);
  });

  it("serializes edits, activation validation and V3 slot allocation", () => {
    const source = readSource(
      "src/modules/communication-automations/services/communication-automation.service.ts",
    );
    const updateTransaction = source.indexOf(
      "Every edit takes the tenant write lock",
    );
    const tenantLock = source.indexOf(
      "TenantModel.findOneAndUpdate",
      updateTransaction,
    );
    const currentRead = source.indexOf(
      "communicationAutomationRepository.findByIdForTenant",
      tenantLock,
    );
    const merge = source.indexOf("const merged", currentRead);
    const activationValidation = source.indexOf(
      "assertAutomationCanActivate(tenantId, merged)",
      merge,
    );
    const activeLimitCheck = source.indexOf(
      'assertAutomationPlanLimit(tenantId, session, "activate")',
      activationValidation,
    );
    const update = source.indexOf(
      "communicationAutomationRepository.update",
      activeLimitCheck,
    );

    expect(updateTransaction).toBeGreaterThan(-1);
    expect(tenantLock).toBeGreaterThan(updateTransaction);
    expect(currentRead).toBeGreaterThan(tenantLock);
    expect(merge).toBeGreaterThan(currentRead);
    expect(activationValidation).toBeGreaterThan(merge);
    expect(activeLimitCheck).toBeGreaterThan(activationValidation);
    expect(update).toBeGreaterThan(activeLimitCheck);
  });

  it("binds both the count and document save to the transaction session", () => {
    const source = readSource(
      "src/modules/communication-automations/communication-automation.repository.ts",
    );

    expect(source).toContain("if (session) query.session(session)");
    expect(source).toContain("...(activeOnly ? { isActive: true } : {})");
    expect(source).toContain(
      "return automation.save(session ? { session } : undefined)",
    );
  });
});
