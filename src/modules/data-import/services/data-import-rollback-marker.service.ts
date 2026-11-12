export const IMPORT_RECORD_ROLLED_BACK = "IMPORT_RECORD_ROLLED_BACK";

export const isRolledBackImportRecord = (record: any): boolean =>
  Boolean(
    record?.importMetadata?.rolledBackAt ||
    record?.importMetadata?.rollbackMutationKey ||
    record?.rolledBackAt ||
    record?.rollbackMutationKey,
  );

export const assertImportRecordNotRolledBack = (record: any): void => {
  if (!record || !isRolledBackImportRecord(record)) return;
  throw Object.assign(
    new Error(
      "This record was deactivated by an earlier import rollback and cannot be re-imported automatically.",
    ),
    { code: IMPORT_RECORD_ROLLED_BACK },
  );
};

export const rolledBackImportIssue = Object.freeze({
  code: IMPORT_RECORD_ROLLED_BACK,
  severity: "error" as const,
  message:
    "This record was deactivated by an earlier import rollback and cannot be re-imported automatically.",
});
