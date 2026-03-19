ALTER TABLE streams ADD COLUMN log_level TEXT NOT NULL DEFAULT 'info' CHECK (log_level IN ('debug', 'info', 'warn', 'error'));
