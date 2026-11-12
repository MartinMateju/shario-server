# Knowledge Hub locale-safe text index

Knowledge articles retain their actual locale in `language`, including `cs`.
MongoDB's previous text index treated that field as a stemming-language override
and rejected Czech writes with code 17262. The replacement uses
`default_language: "none"` and a separate `textIndexLanguage` override field that
the article schema/API does not populate. Search remains tenant-scoped and
token-based, without language-specific stemming. AI embedding eligibility and
the article locale are unchanged.

The API awaits `ensureKnowledgeTextIndex` after connecting to MongoDB and before
starting cron jobs, accepting HTTP traffic or marking readiness. This follows
the existing product-index startup repair pattern. It manages this text index
explicitly instead of declaring it in Mongoose, which would race automatic index
creation against repair of an existing database.

- Only the exact known legacy name
  `tenantId_1_title_text_summary_text_content_text_transcript_text_tags_text`,
  expected key/weights, English default and `language` override are removed.
- The replacement is named `knowledge_text_locale_neutral_v1`. Its separate name
  prevents concurrent starting instances from dropping a repaired index.
- Documents and all other indexes, including tenant/slug uniqueness, are
  preserved. Repeated startup with the verified replacement does no index writes.
- MongoDB permits one text index per collection, so this upgrade requires a
  brief drop/build interval. Other live API instances may temporarily fail text
  searches during that interval. Unknown definitions, failed drops or failed
  builds block this new API instance from becoming ready; they are not ignored.
- An interrupted build can safely resume on the next startup. Do not restore the
  old index: it rejects valid Czech articles and may no longer be buildable after
  those articles exist. A code rollback must retain this repaired index and must
  not use broad `syncIndexes` or restore/delete knowledge documents.

Deployment needs the same index-list/create/drop database privileges as the
existing startup repairs. Verify the intended API revision, successful startup
and `/ready`, then confirm the authorized Czech source saves and can be read
back. A successful save is distinct from asynchronous embedding completion.
No manual production command or database credential is required by this change.
