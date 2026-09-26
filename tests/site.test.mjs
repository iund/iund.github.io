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
const API = {
	[`users/${OTHER.split('/')[0]}/repos`]: [repo(OTHER), repo('someone/plain', { topics: [], description: null }), repo('someone/forked', { fork: true })],
	'repos/someone/forked': { ...repo('someone/forked', { fork: true }), parent: { full_name: OTHER } },
	[`repos/${OTHER}/releases`]: [{ name: 'v1.1', tag_name: 'v1.1', draft: false, prerelease: false, published_at: '2026-02-02T00:00:00Z', body_html: '', assets: [] }, { name: 'v1.0', tag_name: 'v1.0', draft: false, prerelease: false, published_at: '2026-01-02T00:00:00Z', body_html: '<p>notes</p>',
		assets: [{ name: 'tool.tar.gz', size: 2048, download_count: 5, browser_download_url: `https://github.com/${OTHER}/releases/download/v1.0/tool.tar.gz` }] }],
	'search/repositories': { total_count: 2, items: [repo('big/famous', { stargazers_count: 50000 }), repo('tiny/gem', { stargazers_count: 5 })] },
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
	const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': 'GET, PUT, DELETE',
		'access-control-expose-headers': 'etag, x-ratelimit-remaining, x-ratelimit-limit, x-ratelimit-reset, x-ratelimit-resource' };
	await ctx.route('https://api.github.com/**', route => {
		if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
		const path = new URL(route.request().url()).pathname.slice(1);
		if (path !== 'rate_limit') calls.push(path);
		const body = API[path];
		route.fulfill({ status: body ? 200 : 404, contentType: 'application/json', body: JSON.stringify(body ?? {}),
			headers: { ...cors, 'x-ratelimit-remaining': '59', 'x-ratelimit-limit': '60', 'x-ratelimit-reset': '2000000000', 'x-ratelimit-resource': path.startsWith('search/') ? 'search' : 'core' } });
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
	const labels = await page.$$eval('main .head .clone > :not(.sep)', els => els.map(e => e.textContent.trim()));
	assert.deepEqual(labels, ['star', 'github', 'ssh', 'https', 'zip', 'releases', 'actions', 'readme', 'files']);
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
