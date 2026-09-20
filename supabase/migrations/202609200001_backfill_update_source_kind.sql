-- Historical releases created before source_kind was persisted still retain
-- first-party evidence metadata. Backfill the canonical lane classification so
-- deterministic confidence caps and public source labels remain consistent.
UPDATE public.software_updates AS update_row
SET source_kind = CASE
  WHEN EXISTS (
    SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(update_row.evidence) = 'array' THEN update_row.evidence ELSE '[]'::jsonb END) AS item
    WHERE lower(COALESCE(item->>'sourceKind', item->>'releaseType', '')) IN
      ('official-security-release', 'security-release')
  ) THEN 'official-security-release'
  WHEN EXISTS (
    SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(update_row.evidence) = 'array' THEN update_row.evidence ELSE '[]'::jsonb END) AS item
    WHERE lower(COALESCE(item->>'sourceKind', item->>'releaseType', '')) IN
      ('official-security-advisory', 'security-advisory', 'official-security-index')
  ) THEN 'official-security-advisory'
  WHEN EXISTS (
    SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(update_row.evidence) = 'array' THEN update_row.evidence ELSE '[]'::jsonb END) AS item
    WHERE lower(COALESCE(item->>'sourceKind', item->>'releaseType', '')) = 'official-release-notes'
  ) THEN 'official-release-notes'
  WHEN EXISTS (
    SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(update_row.evidence) = 'array' THEN update_row.evidence ELSE '[]'::jsonb END) AS item
    WHERE lower(COALESCE(item->>'sourceKind', item->>'releaseType', '')) = 'official-game-update'
  ) THEN 'official-game-update'
  WHEN EXISTS (
    SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(update_row.evidence) = 'array' THEN update_row.evidence ELSE '[]'::jsonb END) AS item
    WHERE lower(COALESCE(item->>'sourceKind', item->>'releaseType', '')) = 'official-release'
  ) THEN 'official-release'
  WHEN EXISTS (
    SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(update_row.evidence) = 'array' THEN update_row.evidence ELSE '[]'::jsonb END) AS item
    WHERE lower(COALESCE(item->>'sourceKind', item->>'releaseType', '')) IN
      ('official-artifact', 'artifact-only')
  ) THEN 'official-artifact'
  WHEN EXISTS (
    SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(update_row.evidence) = 'array' THEN update_row.evidence ELSE '[]'::jsonb END) AS item
    WHERE lower(COALESCE(item->>'sourceKind', item->>'releaseType', '')) IN
      ('official-version', 'version-only')
  ) THEN 'official-version'
  ELSE 'official-source'
END,
updated_at = now()
WHERE update_row.source_kind IS NULL
  AND jsonb_typeof(COALESCE(update_row.evidence, '[]'::jsonb)) = 'array'
  AND EXISTS (
    SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(update_row.evidence) = 'array' THEN update_row.evidence ELSE '[]'::jsonb END) AS item
    WHERE COALESCE(item->>'url', '') ~ '^https://'
      AND COALESCE(item->>'url', '') !~* 'reddit\.com'
  );
