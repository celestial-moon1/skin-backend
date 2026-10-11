'use strict';

// Plain HTML pages for the skin website. No framework and no build step.
// Every value that comes from a user or the database goes through escapeHtml.

function escapeHtml(value) {
	return String(value)
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&#39;');
}

function layout(title, body, account) {
	const nav = account
		? '<a href="/">Home</a> <a href="/upload">Upload skin</a> <a href="/link">Link game</a> ' +
		  '<form method="post" action="/logout" class="inline"><button type="submit">Log out</button></form>'
		: '<a href="/login">Log in</a> <a href="/register">Create account</a>';
	return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)} - Skin backend</title>
<style>
body { font-family: sans-serif; max-width: 640px; margin: 2em auto; padding: 0 1em; }
nav a { margin-right: 1em; }
form.inline { display: inline; }
form label { display: block; margin-top: 1em; }
input { padding: 0.4em; }
button { padding: 0.4em 1em; margin-top: 1em; }
code { font-size: 1.2em; }
.error { color: #b00020; }
.ok { color: #1b5e20; }
img.skin { image-rendering: pixelated; width: 128px; background: #eee; }
</style>
</head>
<body>
<nav>${nav}</nav>
<h1>${escapeHtml(title)}</h1>
${body}
</body>
</html>`;
}

function message(error, ok) {
	if (error) return `<p class="error">${escapeHtml(error)}</p>`;
	if (ok) return `<p class="ok">${escapeHtml(ok)}</p>`;
	return '';
}

function home(account) {
	if (!account) {
		return layout('Skin backend',
			'<p>Create an account or log in to upload your skin and link the game.</p>' +
			'<p>The game shows a code when you start linking. Enter it on the Link game page.</p>',
			null);
	}
	return layout('Skin backend',
		`<p>Signed in as <strong>${escapeHtml(account.username)}</strong>.</p>` +
		`<p>Your game ID (XUID): <code>${escapeHtml(account.xuid)}</code></p>` +
		'<p><a href="/upload">Upload your skin</a> or <a href="/link">link the game</a>.</p>',
		account);
}

function register({ error, username }) {
	return layout('Create account',
		message(error) +
		'<form method="post" action="/register">' +
		`<label>Username (3 to 16 letters, numbers or _)<br><input name="username" value="${escapeHtml(username || '')}" required maxlength="16" pattern="[A-Za-z0-9_]{3,16}"></label>` +
		'<label>Password (8 to 200 characters)<br><input type="password" name="password" required minlength="8" maxlength="200"></label>' +
		'<button type="submit">Create account</button>' +
		'</form>',
		null);
}

function login({ error, username }) {
	return layout('Log in',
		message(error) +
		'<form method="post" action="/login">' +
		`<label>Username<br><input name="username" value="${escapeHtml(username || '')}" required maxlength="16"></label>` +
		'<label>Password<br><input type="password" name="password" required maxlength="200"></label>' +
		'<button type="submit">Log in</button>' +
		'</form>',
		null);
}

function link({ account, error, ok }) {
	return layout('Link game',
		message(error, ok) +
		'<p>In the game, choose to link your account. It shows an 8-character code. Enter it here.</p>' +
		'<form method="post" action="/link">' +
		'<label>Code from the game<br><input name="code" required maxlength="12" autocomplete="off" placeholder="XXXX-XXXX"></label>' +
		'<button type="submit">Link</button>' +
		'</form>',
		account);
}

function upload({ account, error, ok }) {
	const xuid = escapeHtml(account.xuid);
	return layout('Upload skin',
		message(error, ok) +
		'<p>Current skin:</p>' +
		`<img class="skin" id="current" src="/skins/${xuid}" alt="" onerror="this.style.display='none'">` +
		'<p><input type="file" id="file" accept="image/png"> ' +
		'<button type="button" id="send">Upload</button></p>' +
		'<p>PNG only, 64x32 or 64x64 pixels.</p>' +
		'<p id="status"></p>' +
		'<script>' +
		'document.getElementById("send").addEventListener("click", async function () {' +
		'  var status = document.getElementById("status");' +
		'  var file = document.getElementById("file").files[0];' +
		'  if (!file) { status.className = "error"; status.textContent = "Choose a PNG first."; return; }' +
		'  status.className = ""; status.textContent = "Uploading...";' +
		'  try {' +
		'    var res = await fetch("/me/skin", { method: "PUT", headers: { "Content-Type": "image/png" }, body: file, credentials: "same-origin" });' +
		'    var data = await res.json().catch(function () { return {}; });' +
		'    if (res.ok) {' +
		'      status.className = "ok"; status.textContent = "Uploaded.";' +
		'      document.getElementById("current").style.display = "";' +
		'      document.getElementById("current").src = "/skins/' + xuid + '?" + Date.now();' +
		'    } else {' +
		'      status.className = "error"; status.textContent = data.error || ("Upload failed (" + res.status + ")");' +
		'    }' +
		'  } catch (e) { status.className = "error"; status.textContent = "Upload failed: network error."; }' +
		'});' +
		'</script>',
		account);
}

module.exports = { home, register, login, link, upload };
