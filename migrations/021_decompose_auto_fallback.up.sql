ALTER TABLE streams ADD COLUMN auto_probe BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE streams ADD COLUMN quality_fallback BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE streams ADD COLUMN offload_chunks BOOLEAN NOT NULL DEFAULT false;

UPDATE streams SET auto_probe = auto_fallback;

ALTER TABLE streams DROP COLUMN auto_fallback;
