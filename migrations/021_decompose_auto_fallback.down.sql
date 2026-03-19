ALTER TABLE streams ADD COLUMN auto_fallback BOOLEAN NOT NULL DEFAULT false;

UPDATE streams SET auto_fallback = auto_probe;

ALTER TABLE streams DROP COLUMN auto_probe;
ALTER TABLE streams DROP COLUMN quality_fallback;
ALTER TABLE streams DROP COLUMN offload_chunks;
