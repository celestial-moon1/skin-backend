'use strict';

// Passwords, sessions, XUIDs and link codes. Uses only Node's built-in crypto module.
// Placeholder login: there is no email check, no password reset and no rate limit yet.

const crypto = require('crypto');

const SESSION_DAYS = 30;
const LINK_MINUTES = 10;
// Excludes 0, O, 1 and I so the code is easy to read and type.
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function sha256Hex(text) {
	return crypto.createHash('sha256').update(text).digest('hex');
}

function randomToken() {
	return crypto.randomBytes(32).toString('base64url');
}

function randomCode() {
	const bytes = crypto.randomBytes(8);
	let code = '';
	for (let i = 0; i < 8; i++) {
		code += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
	}
	return code.slice(0, 4) + '-' + code.slice(4);
}

// Normalises what a player types: no spaces, upper case, and a missing dash is fine.
function normaliseCode(input) {
	return String(input).toUpperCase().replace(/[^A-Z0-9]/g, '');
}

function hashPassword(password) {
	const salt = crypto.randomBytes(16);
	const hash = crypto.scryptSync(password, salt, 64);
	return 'scrypt$' + salt.toString('hex') + '$' + hash.toString('hex');
}

function verifyPassword(password, stored) {
	const parts = String(stored).split('$');
	if (parts.length !== 3 || parts[0] !== 'scrypt') return false;
	const salt = Buffer.from(parts[1], 'hex');
	const expected = Buffer.from(parts[2], 'hex');
	const actual = crypto.scryptSync(password, salt, expected.length);
	return crypto.timingSafeEqual(actual, expected);
}

// A new XUID for an account. Random, with the top bit set so it is a large 64-bit number like real XUIDs.
function newXuid() {
	const bytes = crypto.randomBytes(8);
	bytes[0] |= 0x80;
	return BigInt('0x' + bytes.toString('hex')).toString();
}

function sessionExpiry() {
	return new Date(Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000);
}

function linkExpiry() {
	return new Date(Date.now() + LINK_MINUTES * 60 * 1000);
}

function parseCookies(header) {
	const out = {};
	if (!header) return out;
	for (const part of header.split(';')) {
		const idx = part.indexOf('=');
		if (idx < 0) continue;
		out[part.slice(0, idx).trim()] = decodeURIComponent(part.slice(idx + 1).trim());
	}
	return out;
}

function sessionCookie(token) {
	return `session=${encodeURIComponent(token)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_DAYS * 24 * 60 * 60}`;
}

function clearSessionCookie() {
	return 'session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0';
}

module.exports = {
	sha256Hex,
	randomToken,
	randomCode,
	normaliseCode,
	hashPassword,
	verifyPassword,
	newXuid,
	sessionExpiry,
	linkExpiry,
	parseCookies,
	sessionCookie,
	clearSessionCookie,
};
