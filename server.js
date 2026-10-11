'use strict';

// Custom skin backend. Sits between the game client and Neon (hosted PostgreSQL).
// Identity: the client sends its XUID in the X-Player-Xuid header and it must match the path.
// This is a claim, not authentication. Token-based auth comes later.

const http = require('http');
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

const PORT = Number(process.env.PORT) || 8080;
const MAX_BODY_BYTES = 64 * 1024;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const ALLOWED_SIZES = [
	{ width: 64, height: 32 },
	{ width: 64, height: 64 },
];

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

function isValidSkinPng(buf) {
	// Layout: 8 bytes signature, 4 bytes IHDR length, 4 bytes type ("IHDR"), then 4 bytes width and 4 bytes height.
	if (buf.length < 24) return false;
	if (!buf.subarray(0, 8).equals(PNG_SIGNATURE)) return false;
	if (buf.toString('ascii', 12, 16) !== 'IHDR') return false;
	const width = buf.readUInt32BE(16);
	const height = buf.readUInt32BE(20);
	return ALLOWED_SIZES.some((s) => s.width === width && s.height === height);
}

function sendJson(res, status, obj) {
	const body = JSON.stringify(obj);
	res.writeHead(status, {
		'Content-Type': 'application/json',
		'Content-Length': Buffer.byteLength(body),
	});
	res.end(body);
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
		req.on('end', () => resolve(Buffer.concat(chunks)));
		req.on('error', reject);
	});
}

async function handleGetSkin(xuid, res) {
	const result = await pool.query('SELECT png FROM skins WHERE xuid = $1', [xuid]);
	if (result.rowCount === 0) throw new HttpError(404, 'no skin for this xuid');
	const png = result.rows[0].png;
	res.writeHead(200, {
		'Content-Type': 'image/png',
		'Content-Length': png.length,
		'Cache-Control': 'no-cache',
	});
	res.end(png);
}

async function handlePutSkin(xuid, req, res) {
	if (req.headers['x-player-xuid'] !== xuid) {
		throw new HttpError(403, 'X-Player-Xuid header does not match the path');
	}
	const contentType = (req.headers['content-type'] || '').split(';')[0].trim();
	if (contentType !== 'image/png') {
		throw new HttpError(415, 'content-type must be image/png');
	}
	const png = await readBody(req);
	if (!isValidSkinPng(png)) {
		throw new HttpError(400, 'invalid png: must be 64x32 or 64x64');
	}
	await pool.query(
		`INSERT INTO skins (xuid, png, updated_at) VALUES ($1, $2, now())
		 ON CONFLICT (xuid) DO UPDATE SET png = EXCLUDED.png, updated_at = now()`,
		[xuid, png]
	);
	sendJson(res, 200, { ok: true, xuid, bytes: png.length });
}

const server = http.createServer(async (req, res) => {
	try {
		const url = new URL(req.url, 'http://localhost');

		if (req.method === 'GET' && url.pathname === '/health') {
			sendJson(res, 200, { ok: true });
			return;
		}

		const match = /^\/skins\/([0-9]{1,20})$/.exec(url.pathname);
		if (!match) throw new HttpError(404, 'not found');
		const xuid = match[1];

		if (req.method === 'GET') {
			await handleGetSkin(xuid, res);
		} else if (req.method === 'PUT') {
			await handlePutSkin(xuid, req, res);
		} else {
			throw new HttpError(405, 'method not allowed');
		}
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
