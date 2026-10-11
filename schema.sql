-- Custom skins keyed by XUID. Run automatically at startup (IF NOT EXISTS keeps it idempotent).
CREATE TABLE IF NOT EXISTS skins (
	xuid       TEXT PRIMARY KEY,
	png        BYTEA NOT NULL,
	updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
