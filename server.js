'use strict';

// Skin backend. Sits between the game client, the website and Neon (hosted PostgreSQL).
//
// Game routes:
//   GET  /skins/<xuid>           PNG skin for an XUID (read only)
//   GET  /capes/<xuid>           PNG cape for an XUID (read only, no arm model header)
//   POST /link/start             game asks for a link code; returns { code, token, expiresIn }
//   GET  /link/status?token=...  game polls; { status: "pending" } or { status: "claimed", xuid, username }
//
// Website routes (cookie session):
//   /, /register, /login, /logout, /link, /upload
//   PUT /me/skin?model=classic|slim   upload a PNG for the logged-in account and set its arm model
//                                     GET /skins/<xuid> returns the model in the X-Skin-Model header
//   PUT /me/cape                      upload a cape PNG for the logged-in account (no arm model)
//
// Other routes:
//   GET /health  liveness; { ok, commit } where commit is the revision this process was built from

const http = require('http');
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');
const auth = require('./auth');
const pages = require('./pages');

const PORT = Number(process.env.PORT) || 8080;
const MAX_BODY_BYTES = 64 * 1024;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const ALLOWED_SIZES = [
	{ width: 64, height: 32 },
	{ width: 64, height: 64 },
];
const USERNAME_RE = /^[A-Za-z0-9_]{3,16}$/;
// Arm models a skin can use. The game maps 'slim' to the 3-pixel-arm model and everything else to the classic one.
const SKIN_MODELS = ['classic', 'slim'];
// The commit this process was built from, so the revision actually running can be checked from outside.
// Render exposes it as RENDER_GIT_COMMIT on every deploy. Elsewhere it is absent, which reads as null.
const GIT_COMMIT = process.env.RENDER_GIT_COMMIT || null;

if (!process.env.DATABASE_URL) {
	console.error('DATABASE_URL is not set. Set it to your Neon connection string.');
	process.exit(1);
}

// Neon requires TLS. Set DB_SSL=false only for a local Postgres during development.
const pool = new Pool({
	connectionString: process.env.DATABASE_URL,
	ssl: process.env.DB_SSL === 'false' ? false : { rejectUnauthorized: true },
	max: 5,
});

class HttpError extends Error {
	constructor(status, message) {
		super(message);
		this.status = status;
	}
}

// Checked for a skin and a cape alike: both are 64 pixel wide sheets. Which of the two allowed heights is
// correct depends only on the sheet the artist drew. Nothing else about the image is inspected, and a cape
// has no arm model, so no other property is needed.
function isValidPng(buf) {
	// Layout: 8 bytes signature, 4 bytes IHDR length, 4 bytes type ("IHDR"), then 4 bytes width and 4 bytes height.
	if (buf.length < 24) return false;
	if (!buf.subarray(0, 8).equals(PNG_SIGNATURE)) return false;
	if (buf.toString('ascii', 12, 16) !== 'IHDR') return false;
	const width = buf.readUInt32BE(16);
	const height = buf.readUInt32BE(20);
	return ALLOWED_SIZES.some((s) => s.width === width && s.height === height);
}

// Maps a user-supplied model to a stored value. A missing or unknown value falls back to classic.
function normaliseSkinModel(value) {
	const model = String(value == null ? '' : value).trim().toLowerCase();
	return SKIN_MODELS.includes(model) ? model : 'classic';
}

function sendJson(res, status, obj) {
	const body = JSON.stringify(obj);
	res.writeHead(status, {
		'Content-Type': 'application/json',
		'Content-Length': Buffer.byteLength(body),
	});
	res.end(body);
}

function sendHtml(res, status, html, extraHeaders) {
	res.writeHead(status, Object.assign({
		'Content-Type': 'text/html; charset=utf-8',
		'Content-Length': Buffer.byteLength(html),
	}, extraHeaders || {}));
	res.end(html);
}

function redirect(res, location, extraHeaders) {
	res.writeHead(303, Object.assign({ Location: location }, extraHeaders || {}));
	res.end();
}

function readBody(req) {
	return new Promise((resolve, reject) => {
		const chunks = [];
		let total = 0;
		let tooLarge = false;
		req.on('data', (chunk) => {
			total += chunk.length;
			if (total > MAX_BODY_BYTES) {
				// Keep the socket open so the 413 reaches the client. Destroying it makes Render's proxy return 502.
				if (!tooLarge) {
					tooLarge = true;
					reject(new HttpError(413, 'body too large'));
				}
				return;
			}
			chunks.push(chunk);
		});
		req.on('end', () => {
			if (!tooLarge) resolve(Buffer.concat(chunks));
		});
		req.on('error', reject);
	});
}

// Form posts are small, so they are read as text.
async function readForm(req) {
	const raw = (await readBody(req)).toString('utf8');
	const out = {};
	for (const [k, v] of new URLSearchParams(raw)) out[k] = v;
	return out;
}

async function currentAccount(req) {
	const cookies = auth.parseCookies(req.headers.cookie);
	if (!cookies.session) return null;
	const result = await pool.query(
		`SELECT a.id, a.username, a.xuid
		   FROM sessions s JOIN accounts a ON a.id = s.account_id
		  WHERE s.token_hash = $1 AND s.expires_at > now()`,
		[auth.sha256Hex(cookies.session)]
	);
	return result.rowCount === 0 ? null : result.rows[0];
}

async function requireAccount(req) {
	const account = await currentAccount(req);
	if (!account) throw new HttpError(401, 'log in first');
	return account;
}


// ---- Game routes -----------------------------------------------------------

// The game sends its device secret as "Authorization: Bearer <token>". The server returns the account
// that secret belongs to, so the XUID comes from the server and not from a local file.
async function handleGameMe(req, res) {
	const header = req.headers.authorization || '';
	const match = /^Bearer ([A-Za-z0-9_-]{20,128})$/.exec(header);
	if (!match) throw new HttpError(401, 'device token required');
	const result = await pool.query(
		`SELECT a.xuid, a.username
		   FROM device_tokens d JOIN accounts a ON a.id = d.account_id
		  WHERE d.token_hash = $1`,
		[auth.sha256Hex(match[1])]
	);
	if (result.rowCount === 0) throw new HttpError(401, 'device token not recognised');
	sendJson(res, 200, { xuid: result.rows[0].xuid, username: result.rows[0].username });
}

// The game calls this when the player logs out. It deletes this device's row so the token stops working.
// It is idempotent: an unknown or already-revoked token still gets 200, so the game can ignore the result.
async function handleGameLogout(req, res) {
	const header = req.headers.authorization || '';
	const match = /^Bearer ([A-Za-z0-9_-]{20,128})$/.exec(header);
	if (!match) throw new HttpError(401, 'device token required');
	const result = await pool.query('DELETE FROM device_tokens WHERE token_hash = $1', [auth.sha256Hex(match[1])]);
	sendJson(res, 200, { ok: true, revoked: result.rowCount > 0 });
}

async function handleGetSkin(xuid, res) {
	const result = await pool.query('SELECT png, model FROM skins WHERE xuid = $1', [xuid]);
	if (result.rowCount === 0) throw new HttpError(404, 'no skin for this xuid');
	const png = result.rows[0].png;
	res.writeHead(200, {
		'Content-Type': 'image/png',
		'Content-Length': png.length,
		'Cache-Control': 'no-cache',
		// The game reads this to pick the arm model. An absent header means classic, so old rows keep working.
		'X-Skin-Model': normaliseSkinModel(result.rows[0].model),
	});
	res.end(png);
}

// A cape is its own sheet, so this never touches the skin row. There is no arm model for a cape, hence no
// response header: the game renders the cape from the model's own UVs.
async function handleGetCape(xuid, res) {
	const result = await pool.query('SELECT png FROM capes WHERE xuid = $1', [xuid]);
	if (result.rowCount === 0) throw new HttpError(404, 'no cape for this xuid');
	const png = result.rows[0].png;
	res.writeHead(200, {
		'Content-Type': 'image/png',
		'Content-Length': png.length,
		'Cache-Control': 'no-cache',
	});
	res.end(png);
}

async function handleLinkStart(res) {
	const code = auth.randomCode();
	const token = auth.randomToken();
	// Drop expired requests first so the table stays small.
	await pool.query('DELETE FROM link_requests WHERE expires_at < now()');
	await pool.query(
		`INSERT INTO link_requests (token_hash, code_hash, account_id, expires_at)
		 VALUES ($1, $2, NULL, $3)`,
		[auth.sha256Hex(token), auth.sha256Hex(auth.normaliseCode(code)), auth.linkExpiry()]
	);
	sendJson(res, 200, { code, token, expiresIn: 600 });
}

async function handleLinkStatus(url, res) {
	const token = url.searchParams.get('token') || '';
	if (!token) throw new HttpError(400, 'token is required');
	const result = await pool.query(
		`SELECT l.account_id, a.xuid, a.username, l.expires_at > now() AS live
		   FROM link_requests l LEFT JOIN accounts a ON a.id = l.account_id
		  WHERE l.token_hash = $1`,
		[auth.sha256Hex(token)]
	);
	if (result.rowCount === 0) throw new HttpError(404, 'unknown or expired link');
	const row = result.rows[0];
	if (row.account_id !== null) {
		// Claimed. The request is single use, so delete it once the game has the XUID.
		// The device secret is issued here, once. The game stores it and sends it to /game/me.
		const deviceToken = auth.randomToken();
		await pool.query('DELETE FROM link_requests WHERE token_hash = $1', [auth.sha256Hex(token)]);
		await pool.query(
			'INSERT INTO device_tokens (token_hash, account_id) VALUES ($1, $2)',
			[auth.sha256Hex(deviceToken), row.account_id]
		);
		return sendJson(res, 200, { status: 'claimed', xuid: row.xuid, username: row.username, deviceToken });
	}
	if (!row.live) throw new HttpError(410, 'link code expired');
	sendJson(res, 200, { status: 'pending' });
}
// ---- Website routes --------------------------------------------------------

async function startSession(accountId, res) {
	const token = auth.randomToken();
	await pool.query(
		'INSERT INTO sessions (token_hash, account_id, expires_at) VALUES ($1, $2, $3)',
		[auth.sha256Hex(token), accountId, auth.sessionExpiry()]
	);
	res.setHeader('Set-Cookie', auth.sessionCookie(token));
}

async function handleRegister(req, res) {
	if (req.method === 'GET') return sendHtml(res, 200, pages.register({}));
	const form = await readForm(req);
	const username = (form.username || '').trim();
	const password = form.password || '';
	if (!USERNAME_RE.test(username)) {
		return sendHtml(res, 400, pages.register({ error: 'Username must be 3 to 16 letters, numbers or _.', username }));
	}
	if (password.length < 8 || password.length > 200) {
		return sendHtml(res, 400, pages.register({ error: 'Password must be 8 to 200 characters.', username }));
	}
	try {
		const created = await pool.query(
			`INSERT INTO accounts (username, password_hash, xuid)
			 VALUES ($1, $2, $3) RETURNING id`,
			[username, auth.hashPassword(password), auth.newXuid()]
		);
		await startSession(created.rows[0].id, res);
		redirect(res, '/');
	} catch (err) {
		if (err.code === '23505') {
			return sendHtml(res, 409, pages.register({ error: 'That username is taken.', username }));
		}
		throw err;
	}
}

async function handleLogin(req, res) {
	if (req.method === 'GET') return sendHtml(res, 200, pages.login({}));
	const form = await readForm(req);
	const username = (form.username || '').trim();
	const password = form.password || '';
	const result = await pool.query('SELECT id, password_hash FROM accounts WHERE username = $1', [username]);
	// Same message for an unknown user and a wrong password, so usernames are not revealed.
	if (result.rowCount === 0 || !auth.verifyPassword(password, result.rows[0].password_hash)) {
		return sendHtml(res, 401, pages.login({ error: 'Wrong username or password.', username }));
	}
	await startSession(result.rows[0].id, res);
	redirect(res, '/');
}

async function handleLogout(req, res) {
	const cookies = auth.parseCookies(req.headers.cookie);
	if (cookies.session) {
		await pool.query('DELETE FROM sessions WHERE token_hash = $1', [auth.sha256Hex(cookies.session)]);
	}
	redirect(res, '/', { 'Set-Cookie': auth.clearSessionCookie() });
}


async function handleWebsiteLink(req, res) {
	const account = await currentAccount(req);
	if (!account) return redirect(res, '/login');
	if (req.method === 'GET') return sendHtml(res, 200, pages.link({ account }));
	const form = await readForm(req);
	const code = auth.normaliseCode(form.code || '');
	if (code.length !== 8) {
		return sendHtml(res, 400, pages.link({ account, error: 'Enter the 8-character code from the game.' }));
	}
	// Only an unclaimed, live request can be claimed, so a code works once.
	const claimed = await pool.query(
		`UPDATE link_requests SET account_id = $1
		  WHERE code_hash = $2 AND account_id IS NULL AND expires_at > now()
		  RETURNING token_hash`,
		[account.id, auth.sha256Hex(code)]
	);
	if (claimed.rowCount === 0) {
		return sendHtml(res, 404, pages.link({ account, error: 'Code not found or expired. Start linking again in the game.' }));
	}
	sendHtml(res, 200, pages.link({ account, ok: 'Linked. You can return to the game.' }));
}

async function handleAccountPage(req, res) {
	const account = await currentAccount(req);
	if (!account) return redirect(res, '/login');
	sendHtml(res, 200, pages.account({ account }));
}

async function handleUploadPage(req, res) {
	const account = await currentAccount(req);
	if (!account) return redirect(res, '/login');
	// Pre-select the model already stored, so re-uploading a skin keeps the player's choice.
	const result = await pool.query('SELECT model FROM skins WHERE xuid = $1', [account.xuid]);
	const model = result.rowCount === 0 ? 'classic' : normaliseSkinModel(result.rows[0].model);
	sendHtml(res, 200, pages.upload({ account, model }));
}

async function handleHome(req, res) {
	const account = await currentAccount(req);
	sendHtml(res, 200, pages.home(account));
}

// Changes the website username. The XUID does not change, so the game keeps its identity.
// Same rules as registration. The game picks up the new name the next time it checks /game/me.
async function handleChangeUsername(req, res) {
	const account = await requireAccount(req);
	const form = await readForm(req);
	const username = (form.username || '').trim();
	if (!USERNAME_RE.test(username)) {
		return sendHtml(res, 400, pages.account({ account, error: 'Username must be 3 to 16 letters, numbers or _.' }));
	}
	try {
		await pool.query('UPDATE accounts SET username = $1 WHERE id = $2', [username, account.id]);
	} catch (err) {
		if (err.code === '23505') {
			return sendHtml(res, 409, pages.account({ account, error: 'That username is taken.' }));
		}
		throw err;
	}
	sendHtml(res, 200, pages.account({ account: { ...account, username }, ok: 'Username changed.' }));
}

async function handlePutMySkin(req, res) {
	const account = await requireAccount(req);
	const contentType = (req.headers['content-type'] || '').split(';')[0].trim();
	if (contentType !== 'image/png') {
		throw new HttpError(415, 'content-type must be image/png');
	}
	// The upload page sends the arm model as ?model=classic|slim. Anything else falls back to classic.
	const model = normaliseSkinModel(new URL(req.url, 'http://localhost').searchParams.get('model'));
	const png = await readBody(req);
	if (!isValidPng(png)) {
		throw new HttpError(400, 'invalid png: must be 64x32 or 64x64');
	}
	await pool.query(
		`INSERT INTO skins (xuid, png, model, updated_at) VALUES ($1, $2, $3, now())
		 ON CONFLICT (xuid) DO UPDATE SET png = EXCLUDED.png, model = EXCLUDED.model, updated_at = now()`,
		[account.xuid, png, model]
	);
	sendJson(res, 200, { ok: true, xuid: account.xuid, model, bytes: png.length });
}

// Stores a cape for the logged-in account. Unlike a skin there is no model query parameter, because a cape
// has no arm model: the game always uses the 10x16 sheet at the top left of the image.
async function handlePutMyCape(req, res) {
	const account = await requireAccount(req);
	const contentType = (req.headers['content-type'] || '').split(';')[0].trim();
	if (contentType !== 'image/png') {
		throw new HttpError(415, 'content-type must be image/png');
	}
	const png = await readBody(req);
	if (!isValidPng(png)) {
		throw new HttpError(400, 'invalid png: must be 64x32 or 64x64');
	}
	await pool.query(
		`INSERT INTO capes (xuid, png, updated_at) VALUES ($1, $2, now())
		 ON CONFLICT (xuid) DO UPDATE SET png = EXCLUDED.png, updated_at = now()`,
		[account.xuid, png]
	);
	sendJson(res, 200, { ok: true, xuid: account.xuid, bytes: png.length });
}




// ---- Router and startup ----------------------------------------------------

const server = http.createServer(async (req, res) => {
	try {
		const url = new URL(req.url, 'http://localhost');
		const p = url.pathname;

		// commit is reported so a deploy can be confirmed from outside; absence means the host does not set it.
		if (req.method === 'GET' && p === '/health') return sendJson(res, 200, { ok: true, commit: GIT_COMMIT });

		// Game routes
		const skinMatch = /^\/skins\/([0-9]{1,20})$/.exec(p);
		const capeMatch = /^\/capes\/([0-9]{1,20})$/.exec(p);
		// Each route is awaited so its rejection is caught below. Without await, a 401 or 404 from an async handler crashes the process.
		if (skinMatch && req.method === 'GET') return await handleGetSkin(skinMatch[1], res);
		if (capeMatch && req.method === 'GET') return await handleGetCape(capeMatch[1], res);
		if (p === '/link/start' && req.method === 'POST') return await handleLinkStart(res);
		if (p === '/link/status' && req.method === 'GET') return await handleLinkStatus(url, res);
		if (p === '/game/me' && req.method === 'GET') return await handleGameMe(req, res);
		if (p === '/game/logout' && req.method === 'POST') return await handleGameLogout(req, res);

		// Website routes
		if (p === '/' && req.method === 'GET') return await handleHome(req, res);
		if (p === '/register') return await handleRegister(req, res);
		if (p === '/login') return await handleLogin(req, res);
		if (p === '/logout' && req.method === 'POST') return await handleLogout(req, res);
		if (p === '/link') return await handleWebsiteLink(req, res);
		if (p === '/upload' && req.method === 'GET') return await handleUploadPage(req, res);
		if (p === '/me/skin' && req.method === 'PUT') return await handlePutMySkin(req, res);
		if (p === '/me/cape' && req.method === 'PUT') return await handlePutMyCape(req, res);
		if (p === '/me/username' && req.method === 'POST') return await handleChangeUsername(req, res);
		if (p === '/account' && req.method === 'GET') return await handleAccountPage(req, res);

		throw new HttpError(404, 'not found');
	} catch (err) {
		const isHttp = err instanceof HttpError;
		const status = isHttp ? err.status : 500;
		if (!isHttp) console.error(err);
		if (!res.headersSent) {
			sendJson(res, status, { error: isHttp ? err.message : 'internal error' });
		}
	}
});

async function main() {
	const schemaSql = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
	await pool.query(schemaSql);
	server.listen(PORT, () => {
		console.log(`skin backend listening on port ${PORT}`);
	});
}

main().catch((err) => {
	console.error('failed to start', err);
	process.exit(1);
});
