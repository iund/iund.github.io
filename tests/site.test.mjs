// Browser tests for the built site. GitHub's API and raw file host are mocked so the tests are repeatable
// and use no API allowance; the pinned CDN libraries load for real.
// Run: serve _site on SITE_URL (default http://localhost:8000), then `node --test tests/*.test.mjs`.
// CDN_DIR (optional) serves cdn.jsdelivr.net/npm/<pkg>@<ver>/<file> from <CDN_DIR>/<pkg>/<file>, for offline runs.
import { test, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';

const SITE = process.env.SITE_URL || 'http://localhost:8000';
const OTHER = 'someone/tool';
const repo = (full, extra = {}) => ({
	name: full.split('/')[1], full_name: full, owner: { login: full.split('/')[0] }, description: `${full} description`, language: 'Go',
	stargazers_count: 42, fork: false, archived: false, topics: ['cli'], license: { spdx_id: 'MIT' }, default_branch: 'main',
	html_url: `https://github.com/${full}`, ssh_url: `git@github.com:${full}.git`, clone_url: `https://github.com/${full}.git`,
	forks_count: 3, size: 2048, has_pages: true, is_template: false,
	pushed_at: '2026-01-01T00:00:00Z', created_at: '2025-01-01T00:00:00Z', ...extra,
});
const MANY = Array.from({ length: 105 }, (_, i) => repo(`many/r${i}`, { pushed_at: new Date(2026, 0, 1, 0, 0, 105 - i).toISOString() }));
const API = {
	[`users/${OTHER.split('/')[0]}/repos`]: [repo(OTHER), repo('someone/plain', { topics: [], description: null }), repo('someone/forked', { fork: true })],
	'repos/someone/forked': { ...repo('someone/forked', { fork: true }), parent: { full_name: OTHER } },
	[`repos/${OTHER}/releases`]: [{ name: 'v1.1', tag_name: 'v1.1', draft: false, prerelease: false, published_at: '2026-02-02T00:00:00Z', body_html: '', assets: [] }, { name: 'v1.0', tag_name: 'v1.0', draft: false, prerelease: false, published_at: '2026-01-02T00:00:00Z', body_html: '<p>notes</p>',
		assets: [{ name: 'tool.tar.gz', size: 2048, download_count: 5, browser_download_url: `https://github.com/${OTHER}/releases/download/v1.0/tool.tar.gz` }] }],
	// Similar asks for 12 a page: pages 1 and 2 are full, page 3 ends the query.
	'search/repositories': u => u.searchParams.get('per_page') === '12'
		? { total_count: 29, items: Array.from({ length: u.searchParams.get('page') < 3 ? 12 : 5 }, (_, i) => repo(`sim/p${u.searchParams.get('page')}-${i}`)) }
		: { total_count: 2, items: [repo('big/famous', { stargazers_count: 50000 }), repo('tiny/gem', { stargazers_count: 5 })] },
	'users/many': { login: 'many', name: 'Many Repos', type: 'User', public_repos: 105, avatar_url: 'https://avatars.githubusercontent.com/u/2?v=4', html_url: 'https://github.com/many' },
	'users/many/repos': u => { const pg = +(u.searchParams.get('page') || 1); return MANY.slice((pg - 1) * 100, pg * 100); },
	user: () => ({ login: data.user.login }),
	'user/repos': (u, req) => req.method() === 'POST' ? { ...repo(`${data.user.login}/${req.postDataJSON().name}`, { description: req.postDataJSON().description, private: req.postDataJSON().private }), permissions: { admin: true, push: true, pull: true }, auto_init: req.postDataJSON().auto_init } : [{ ...data.repos[0], permissions: { admin: true, push: true, pull: true } }, repo(`${data.user.login}/secret`, { private: true, permissions: { admin: true, push: true, pull: true } })],
	[`repos/${OTHER}`]: { ...repo(OTHER), permissions: { pull: true } },
	'users/norepos': { login: 'norepos', name: 'No Repos', type: 'User', public_repos: 0, avatar_url: 'https://avatars.githubusercontent.com/u/3?v=4', html_url: 'https://github.com/norepos' },
	'users/norepos/repos': [],
	rate_limit: { resources: { core: { remaining: 60, limit: 60, reset: 2e9 }, search: { remaining: 10, limit: 10, reset: 2e9 } } },
};

let browser, page, calls, errors, data;
before(async () => {
	browser = await chromium.launch();
	const p = await browser.newPage();
	await p.goto(SITE);
	data = JSON.parse(await p.textContent('#site-data'));
	await p.close();
});
after(() => browser.close());
beforeEach(async () => {
	calls = []; errors = [];
	const ctx = await browser.newContext();
	const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': 'GET, PUT, PATCH, POST, DELETE',
		'access-control-expose-headers': 'etag, x-ratelimit-remaining, x-ratelimit-limit, x-ratelimit-reset, x-ratelimit-resource, x-oauth-scopes' };
	await ctx.route('https://api.github.com/**', route => {
		if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
		const u = new URL(route.request().url()), path = u.pathname.slice(1);
		const method = route.request().method();
		if (path !== 'rate_limit') calls.push((method === 'GET' ? '' : method + ' ') + path + (u.searchParams.get('page') > 1 ? '?page=' + u.searchParams.get('page') : ''));
		const body = typeof API[path] === 'function' ? API[path](u, route.request()) : API[path];
		route.fulfill({ status: body ? 200 : 404, contentType: 'application/json', body: JSON.stringify(body ?? {}),
			headers: { ...cors, 'x-ratelimit-remaining': '59', 'x-ratelimit-limit': '60', 'x-ratelimit-reset': '2000000000', 'x-ratelimit-resource': path.startsWith('search/') ? 'search' : 'core', ...(route.request().headers().authorization && { 'x-oauth-scopes': 'gist, repo' }) } });
	});
	await ctx.route('https://raw.githubusercontent.com/**', route => route.fulfill({ headers: { 'access-control-allow-origin': '*' }, body: '# Tool\n\nHello from the README.' }));
	if (process.env.CDN_DIR) await ctx.route('https://cdn.jsdelivr.net/npm/**', route => {
		const [, pkg, file] = new URL(route.request().url()).pathname.match(/^\/npm\/((?:@[^/]+\/)?[^@/]+)@[^/]+\/(.+)$/);
		route.fulfill({ path: `${process.env.CDN_DIR}/${pkg}/${file}`, headers: { 'access-control-allow-origin': '*' } });
	});
	page = await ctx.newPage();
	page.on('pageerror', e => errors.push(e.message));
	page.on('dialog', d => { errors.push('dialog: ' + d.message()); d.dismiss(); });
});
afterEach(async () => {
	await page.context().close();
	assert.deepEqual(errors, [], 'page errors');
});
const open = async hash => { await page.goto(`${SITE}/#${hash}`); await page.waitForLoadState('networkidle'); };
// Your own content must come from the build; only Discover's searches may run.
const apiCalls = () => calls.filter(c => !c.startsWith('search/'));

test('embedded build data lists your repos and gists', async () => {
	assert.ok(data.user && data.user.login, 'user profile');
	assert.ok(Array.isArray(data.repos) && Array.isArray(data.gists));
	await open('');
	assert.equal(await page.locator('[data-sec="mine"] a').count(), data.repos.length);
	assert.equal(await page.locator('[data-sec="gists"] a').count(), data.gists.length);
	assert.equal(await page.textContent('[data-sec="mine"] summary span'), data.user.login);
});

test('home shows your profile tiles without API calls', async () => {
	await open('');
	assert.equal(new URL(page.url()).hash, '#' + data.user.login);
	assert.equal(await page.textContent('main h1'), data.user.name || data.user.login);
	if (data.gists.length) assert.equal(await page.locator('main section:has(h2:text-is("Gists")) .card').count(), data.gists.length);
	assert.deepEqual(apiCalls(), []);
});

test('your repos open from the build with all sections and buttons', async t => {
	if (!data.repos.length) return t.skip('no repos');
	const r = data.repos[0];
	await open(r.full_name);
	assert.equal(await page.textContent('main h1 >> nth=0'), r.name + (r.fork ? ' fork' : '') + (r.archived ? ' archived' : ''));
	const rows = await page.$$eval('main .head .clone .row', rs => rs.map(r => [...r.children].map(e => e.textContent.trim())));
	assert.deepEqual(rows, [['star', 'fork', 'github', 'ssh', 'https', 'zip'], ['releases', 'actions', 'readme', 'files']]);
	assert.deepEqual(await page.$$eval('main > section > h2', hs => hs.map(h => h.textContent)), ['Releases', 'Actions', 'README']);
	assert.equal(await page.locator('#readme script').count(), 0, 'README is sanitised');
	assert.deepEqual(apiCalls(), []);
});

test('old #repo/ links redirect to owner/repo', async t => {
	if (!data.repos.length) return t.skip('no repos');
	await open('repo/' + data.repos[0].name);
	assert.equal(decodeURIComponent(new URL(page.url()).hash), '#' + data.repos[0].full_name);
});

test('gists open from the build', async t => {
	if (!data.gists.length) return t.skip('no gists');
	const g = data.gists[0];
	await open('gist/' + g.id);
	assert.equal(await page.locator('main .filehead').count(), g.files.length);
	assert.equal(await page.locator('[data-sec="gists"] a.active').count(), 1);
	assert.deepEqual(await page.$$eval('main .head [data-copy]', bs => bs.map(b => b.dataset.copy)), [`git@gist.github.com:${g.id}.git`, `https://gist.github.com/${g.id}.git`]);
	assert.equal(await page.isDisabled('#gist-fork'), true, 'fork needs a token');
	assert.equal(await page.evaluate(() => document.fonts.load('16px Iosevka', 'a').then(f => f.length)), 1, 'Iosevka loads from the site');
	assert.equal(await page.evaluate(() => document.fonts.load('16px Iosevka', 'Ж').then(f => f.length)), 1, 'Cyrillic and other scripts load on demand');
	assert.deepEqual(apiCalls(), []);
});

test("another user's repo loads live, with Similar only once scrolled into view", async () => {
	await page.setViewportSize({ width: 1280, height: 400 });
	await open(OTHER);
	assert.equal(await page.textContent('#releases .release h3 >> nth=0'), 'v1.1', 'latest release first');
	assert.equal(await page.isVisible('#releases .older .release'), false, 'older releases start folded');
	await page.click('#releases .older > summary');
	assert.match(await page.textContent('#releases .older'), /Older releases \(1\).*v1\.0.*tool\.tar\.gz/s);
	assert.equal(await page.title(), `${OTHER} · ${data.user.login}`);
	assert.match(await page.textContent('main .head p.muted'), /3 forks.*MIT.*2\.0 MB.*updated .*site/s);
	assert.match(await page.textContent('#readme'), /Hello from the README/);
	assert.ok(await page.isVisible('[data-sec="owner"]'));
	assert.deepEqual(apiCalls(), [`users/someone/repos`, `repos/${OTHER}/releases`]);
	const before = calls.length;
	await page.$eval('main', m => m.scrollTop = m.scrollHeight);
	await page.waitForSelector('#similar .card');
	assert.ok(calls.slice(before).every(c => c.startsWith('search/')), 'Similar uses search only');
	assert.equal(await page.locator('#similar .card').count(), 12);
	await page.$eval('main', m => m.scrollTop = m.scrollHeight);
	await page.waitForFunction(() => document.querySelectorAll('#similar .card').length === 24);
	await page.$eval('main', m => m.scrollTop = m.scrollHeight);
	await page.waitForFunction(() => document.querySelectorAll('#similar .card').length === 29, null, { timeout: 5000 }).catch(() => {});
	assert.ok(await page.locator('#similar .card').count() >= 29, 'Similar keeps paging in as you scroll');
});

test('repos without topics or descriptions open and feed Discover', async () => {
	await open('someone/plain');
	await open(OTHER);
	assert.match(await page.textContent('#releases'), /v1\.1/);
});

test("a fork's tag opens the repo it was forked from", async () => {
	await open('someone/forked');
	const before = calls.length;
	await page.click('main h1 a.tag');
	await page.waitForURL(u => u.hash === '#' + OTHER);
	await page.waitForSelector('#releases .release');
	assert.deepEqual(calls.slice(before).filter(c => !c.startsWith('search/')), ['repos/someone/forked', `repos/${OTHER}/releases`]);
});

test('your forks link straight to their upstream from the build', async t => {
	const fork = data.repos.find(r => r.fork && r.parent);
	if (!fork) return t.skip('no forks');
	await open(fork.full_name);
	assert.equal(await page.getAttribute('main h1 a.tag', 'href'), '#' + fork.parent);
	assert.deepEqual(apiCalls(), []);
});

test('your repos and gists fold away while exploring and reopen at home', async () => {
	const open_ = sec => page.$eval(`[data-sec="${sec}"]`, d => d.open);
	await open(OTHER);
	assert.deepEqual([await open_('mine'), await open_('gists')], [false, false]);
	await page.click('a.home');
	await page.waitForFunction(() => document.querySelector('[data-sec="mine"]').open);
	assert.equal(await open_('gists'), true);
});

test('search puts the most obvious match first and remembers the query', async () => {
	await open('~search/gem');
	await page.waitForSelector('main .card');
	assert.deepEqual(await page.$$eval('main .card b', bs => bs.map(b => b.textContent)), ['tiny/gem', 'big/famous'], 'exact name beats stars');
	assert.equal(await page.getAttribute('#history option', 'value'), 'gem');
});

test('history and settings persist only after accepting storage', async () => {
	await open('~search/gem');
	await page.click('#consent-yes');
	await open(OTHER);
	await page.click('[data-sec="discover"] > summary');
	await page.waitForFunction(() => JSON.parse(localStorage.getItem('explore-open')).discover === false);
	await page.reload();
	await page.waitForLoadState('networkidle');
	assert.equal(await page.isVisible('#consent'), false, 'choice remembered');
	assert.equal(await page.getAttribute('#history option', 'value'), 'gem');
	assert.match(await page.textContent('[data-sec="recent"] a .line >> nth=0'), new RegExp('^' + OTHER));
	assert.equal(await page.$eval('[data-sec="discover"]', d => d.open), false, 'section state remembered');

	await page.click('#token-btn');
	await page.click('#settings .consent-open');
	await page.click('#consent-no');
	await page.reload();
	await page.waitForLoadState('networkidle');
	assert.ok(!(await page.$$eval('#history option', o => o.map(x => x.value))).includes('gem'), 'declining forgets earlier searches');
	assert.deepEqual(await page.evaluate(() => Object.keys(localStorage)), ['explore-consent']);
});

test("an owner's repos page in as you scroll, then Similar appears at the end", async () => {
	await page.setViewportSize({ width: 1280, height: 600 });
	await open('many');
	const tiles = () => page.locator('#all-repos .card').count();
	const scroll = () => page.$eval('main', m => m.scrollTop = m.scrollHeight);
	assert.equal(await tiles(), 30);
	assert.equal(await page.isVisible('#similar'), false);
	for (const want of [60, 90, 100]) { await scroll(); await page.waitForFunction(w => document.querySelectorAll('#all-repos .card').length >= w, want); }
	assert.ok(!calls.includes('users/many/repos?page=2'), 'second page only when reached');
	await scroll();
	await page.waitForFunction(() => document.querySelectorAll('#all-repos .card').length === 105);
	assert.ok(calls.includes('users/many/repos?page=2'));
	assert.equal(await page.textContent('#all-repos .card b >> nth=0'), 'many/r0', 'most recently pushed first');
	await scroll();
	await page.waitForSelector('#similar .card');
	assert.ok((await page.$$eval('#similar .card b', bs => bs.map(b => b.textContent))).every(n => !n.startsWith('many/')), 'Similar leaves out the owner');
});

test('your own token lists private repos and turns your access into buttons', async t => {
	if (!data.repos.length) return t.skip('no repos');
	const me = data.user.login;
	await page.addInitScript(me => Object.entries({ 'explore-consent': 'yes', 'explore-token': '"tok"', 'explore-me': JSON.stringify(me) }).forEach(([k, v]) => localStorage.setItem(k, v)), me);
	API[`repos/${me}/secret/actions/runs`] = { workflow_runs: [{ name: 'CI', head_branch: 'main', status: 'completed', conclusion: 'success', created_at: '2026-01-01T00:00:00Z', html_url: 'https://github.com/x' }] };
	API[`repos/${me}/secret/git/trees/main`] = { truncated: false, tree: [{ path: 'a.txt', type: 'blob', size: 5 }] };
	API[`repos/${me}/secret/contents/a.txt`] = 'hello';
	API[`repos/${me}/secret/actions/workflows`] = { workflows: [{ id: 7, name: 'Pages', path: '.github/workflows/pages.yml', state: 'active' }, { id: 8, name: 'Push only', path: '.github/workflows/push.yml', state: 'active' }] };
	API[`repos/${me}/secret/contents/.github/workflows/pages.yml`] = 'on:\n  workflow_dispatch:\n';
	API[`repos/${me}/secret/contents/.github/workflows/push.yml`] = 'on: push\n';
	API[`repos/${me}/secret/actions/workflows/7/dispatches`] = {};
	API[`repos/${me}/secret`] = (u, req) => repo(`${me}/secret`, { private: true, description: req.postDataJSON().description });
	await open(me);
	assert.equal(await page.locator('[data-sec="mine"] a').count(), 2);
	assert.match(await page.textContent('[data-sec="mine"]'), /secret.*private/s);
	await open(`${me}/secret/blob/main/a.txt`);
	assert.match(await page.textContent('main h1'), /secret private/);
	await page.waitForSelector('#actions [data-run]');
	assert.deepEqual(await page.$$eval('main .head .clone .row > *', els => els.slice(0, 4).map(e => e.textContent.trim())), ['vscode', 'edit', 'star', 'github'], 'no fork button on your own repo');
	const tops = await page.$$eval('main .head .clone .row:first-child > *', els => new Set(els.map(e => Math.round(e.getBoundingClientRect().top))).size);
	assert.equal(tops, 1, 'the action buttons stay on one row');
	assert.deepEqual(await page.$$eval('#actions [data-run]', bs => bs.map(b => b.textContent.trim())), ['Pages'], 'only workflows with workflow_dispatch');
	assert.equal(await page.textContent('#releases > h2 .clone'), 'release');
	await page.click('#actions [data-run]');
	await page.waitForSelector('#actions [data-run]:has-text("started")');
	assert.ok(calls.includes(`POST repos/${me}/secret/actions/workflows/7/dispatches`));
	await page.fill('#rdesc', 'New words');
	await page.press('#rdesc', 'Enter');
	await page.waitForSelector('#rdesc-status:has-text("saved")');
	assert.match(await page.textContent('[data-sec="mine"]'), /New words/);
	await page.waitForSelector('#actions li .tag');
	assert.match(await page.textContent('#actions'), /success CI/);
	assert.match(await page.textContent('#files .file-body pre'), /hello/);
	await open(OTHER);
	await page.waitForFunction(() => document.querySelector('#readme h2'));
	await page.waitForTimeout(300);
	assert.ok(calls.includes(`repos/${OTHER}`), 'permissions fetched');
	assert.equal(await page.locator('main .head a:has-text("edit"), main .head a:has-text("vscode"), input#rdesc').count(), 0, 'read access adds no buttons');
	API[`repos/${OTHER}/forks`] = { ...repo(`${me}/tool`, { fork: true }), permissions: { admin: true, push: true, pull: true } };
	await page.click('#fork');
	await page.waitForFunction(me => location.hash === `#${me}/tool`, me);
	assert.ok(calls.includes(`POST repos/${OTHER}/forks`));
	assert.match(await page.textContent('[data-sec="mine"]'), /tool/);
	await page.click('[data-sec="mine"] #repo-new');
	await page.fill('#rname', 'fresh');
	await page.press('#rname', 'Enter');
	await page.waitForFunction(me => location.hash === `#${me}/fresh`, me);
	await page.waitForSelector('main [data-copy^="git@"]');
	assert.match(await page.textContent('[data-sec="mine"]'), /fresh/);
	assert.ok(calls.includes('POST user/repos'));
	assert.equal(calls.filter(c => c === 'user/repos').length, 1);
});

test('your own token adds, edits and deletes gists, sorted by title', async () => {
	const me = data.user.login, sent = [];
	await page.addInitScript(me => Object.entries({ 'explore-consent': 'yes', 'explore-token': '"tok"', 'explore-me': JSON.stringify(me) }).forEach(([k, v]) => localStorage.setItem(k, v)), me);
	const gist = (id, files, extra = {}) => ({ id, owner: { login: me }, description: 'Zed notes', html_url: `https://gist.github.com/${id}`, updated_at: '2026-01-01T00:00:00Z', public: true,
		files: Object.fromEntries(files.map(f => [f, { filename: f, language: null, raw_url: `https://raw.githubusercontent.com/g/${id}/${f}` }])), ...extra });
	API.gists = (u, req) => {
		if (req.method() !== 'POST') return [gist('z1', ['a.txt', 'b.txt']), gist('a2', ['c.txt'], { description: 'alpha', public: false })];
		const b = req.postDataJSON(); sent.push(b);
		return gist('new1', Object.keys(b.files), { description: b.description });
	};
	API['gists/z1'] = (u, req) => {
		const b = req.postDataJSON(); sent.push(b);
		return gist('z1', ['a.txt', 'b.txt'].filter(f => !b.files || b.files[f] !== null).map(f => b.files?.[f]?.filename || f), b.description != null ? { description: b.description } : {});
	};
	await open('gist/z1');
	assert.deepEqual(await page.$$eval('[data-sec="gists"] a .line', as => as.map(a => a.textContent)), ['alpha', 'Zed notes']);
	assert.equal(await page.locator('[data-sec="gists"] summary #gist-new').count(), 1);
	assert.equal(await page.locator('#gist-fork').count(), 0, 'no fork button on your own gist');
	assert.equal(await page.locator('nav summary > span:nth-child(2):not(:empty)').count(), 2, 'only the repo and gist + are left in the list headings');
	assert.equal(await page.inputValue('main section >> nth=0 >> .fname'), 'a.txt');
	await page.waitForSelector('main section >> nth=0 >> textarea');
	assert.match(await page.inputValue('main section >> nth=0 >> textarea'), /Hello/);
	await page.fill('main section >> nth=0 >> textarea', 'new text');
	await page.fill('main section >> nth=0 >> .fname', 'a2.txt');
	await page.click('main section >> nth=0 >> [data-save-file]');
	await page.waitForSelector('main section[data-file="a2.txt"]');
	assert.deepEqual(sent.at(-1), { files: { 'a.txt': { filename: 'a2.txt', content: 'new text' } } });
	await page.click('main section >> nth=1 >> [data-del-file]');
	await page.click('main section >> nth=1 >> [data-del-file]');
	await page.waitForFunction(() => document.querySelectorAll('main section').length === 1);
	assert.deepEqual(sent.at(-1), { files: { 'b.txt': null } });
	await page.fill('#gdesc', 'Zed notes 2');
	await page.press('#gdesc', 'Enter');
	await page.waitForSelector('#gist-status:has-text("saved")');
	assert.deepEqual(sent.at(-1), { description: 'Zed notes 2' });
	await page.click('#gist-new');
	await page.waitForSelector('#gist-create');
	assert.equal(await page.isChecked('#gpublic'), true);
	await page.fill('main section .fname', 'n.txt');
	await page.fill('main section textarea', 'x');
	await page.click('#gist-create');
	await page.waitForFunction(() => location.hash === '#gist/new1');
	assert.deepEqual(sent.at(-1), { description: '', public: true, files: { 'n.txt': { content: 'x' } } });
});

test('folders unfold in place in the Files tree', async () => {
	API[`repos/${OTHER}/git/trees/main`] = { truncated: false, tree: [{ path: 'README.md', type: 'blob', size: 9 }, { path: 'src', type: 'tree' }, { path: 'src/lib', type: 'tree' }, { path: 'src/lib/x.go', type: 'blob', size: 3 }, { path: 'src/main.go', type: 'blob', size: 5 }] };
	await open(OTHER);
	await page.click('#files > summary');
	await page.waitForSelector('#files details[data-dir="src"]');
	await page.click('#files details[data-dir="src"] > summary');
	await page.click('#files details[data-dir="src/lib"] > summary');
	await page.waitForSelector('#files details[data-dir="src/lib"] a');
	assert.deepEqual(await page.$$eval('#files .tree a, #files .tree summary', els => els.map(e => e.textContent)), ['src/', 'lib/', 'x.go', 'main.go', 'README.md']);
	assert.equal(new URL(page.url()).hash, '#' + OTHER, 'unfolding keeps the view');
	await open(`${OTHER}/tree/main/src/lib`);
	await page.waitForSelector('#files details[data-dir="src/lib"][open] a');
	assert.equal(await page.locator('#files details[open]').count(), 2);
});

test('an owner without repos gets suggestions matching their name', async () => {
	const queries = [];
	page.on('request', r => { const u = new URL(r.url()); if (u.pathname === '/search/repositories') queries.push(u.searchParams.get('q')); });
	await open('norepos');
	await page.waitForSelector('#similar .card');
	assert.ok(queries.some(q => q.startsWith('norepos in:name,description,topics')), 'searched on the name');
});

test('pasted GitHub URLs route to the right view', async () => {
	await open('');
	for (const [input, hash] of [
		[`https://github.com/${OTHER}/tree/main/src`, `#${OTHER}/tree/main/src`],
		[`git@github.com:${OTHER}.git`, `#${OTHER}`],
		['some words', '#~search/some%20words'],
	]) {
		await page.fill('#q', input);
		await page.press('#q', 'Enter');
		assert.equal(new URL(page.url()).hash, hash);
		await page.waitForLoadState('networkidle');
	}
});

test('explore.html redirects to the front page', async () => {
	await page.goto(`${SITE}/explore.html#${OTHER}`);
	await page.waitForURL(u => !u.pathname.endsWith('explore.html'));
	assert.equal(new URL(page.url()).hash, '#' + OTHER);
});
