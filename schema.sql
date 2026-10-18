-- Custom skins keyed by XUID. Run automatically at startup (IF NOT EXISTS keeps it idempotent).
-- model is the arm model picked on the upload page: 'classic' (4-pixel arms) or 'slim' (3-pixel arms, Alex).
-- The PNG size cannot carry this: slim and classic are both commonly 64x64, so the game reads this column.
CREATE TABLE IF NOT EXISTS skins (
	xuid       TEXT PRIMARY KEY,
	png        BYTEA NOT NULL,
	model      TEXT NOT NULL DEFAULT 'classic',
	updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- CREATE TABLE IF NOT EXISTS leaves an existing table untouched, so add the column for databases made before it.
ALTER TABLE skins ADD COLUMN IF NOT EXISTS model TEXT NOT NULL DEFAULT 'classic';

-- Custom capes keyed by XUID, in their own table so a player can have a skin and a cape at the same time.
-- There is no model column: only skins have an arm model. The game reads a cape from the top-left 10x16 area
-- of the sheet, so a classic 64x32 cape and a 64x64 sheet are both stored exactly as uploaded.
CREATE TABLE IF NOT EXISTS capes (
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


-- Game devices. Each link issues one secret token, stored only as a SHA-256 hash. The game sends it to /game/me
-- so the server, not the local uid.dat file alone, decides which XUID this device owns.
CREATE TABLE IF NOT EXISTS device_tokens (
	token_hash TEXT PRIMARY KEY,
	account_id BIGINT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
	created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
