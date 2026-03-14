DROP TABLE IF EXISTS fallback_suggestions;
ALTER TABLE streams DROP COLUMN auto_fallback_kind;
ALTER TABLE streams DROP COLUMN auto_fallback;
