-- Custom skins keyed by XUID. Run automatically at startup (IF NOT EXISTS keeps it idempotent).
CREATE TABLE IF NOT EXISTS skins (
	xuid       TEXT PRIMARY KEY,
	png        BYTEA NOT NULL,
	updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Website accounts. The password is stored as a scrypt hash (see auth.js), never in plain text.
-- The XUID is issued by this backend when the account is created. It is not a real Xbox XUID.
CREATE TABLE IF NOT EXISTS accounts (
	id            BIGSERIAL PRIMARY KEY,
	username      TEXT NOT NULL UNIQUE,
	password_hash TEXT NOT NULL,
	xuid          TEXT NOT NULL UNIQUE,
	created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Login sessions. Only a SHA-256 of the cookie token is stored.
CREATE TABLE IF NOT EXISTS sessions (
	token_hash TEXT PRIMARY KEY,
	account_id BIGINT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
	expires_at TIMESTAMPTZ NOT NULL
);

-- Codes shown in the game. The game keeps the secret token and polls with it.
-- The code is typed on the website to claim the link. Only SHA-256 hashes are stored.
CREATE TABLE IF NOT EXISTS link_requests (
	token_hash TEXT PRIMARY KEY,
	code_hash  TEXT NOT NULL UNIQUE,
	account_id BIGINT REFERENCES accounts(id) ON DELETE CASCADE,
	expires_at TIMESTAMPTZ NOT NULL
);

