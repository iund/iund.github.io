#!/usr/bin/env bash
# Fetches the owner's profile, public repos (README HTML, releases, Actions runs) and gists into _data/ for Jekyll.
set -euo pipefail
U=${GITHUB_REPOSITORY_OWNER:-iund}
T=$(mktemp -d)
mkdir -p _data

gh api "users/$U" --jq '{login, name, bio, blog, location, type, public_repos, followers, avatar_url, html_url}' > _data/user.json
gh api --paginate "users/$U/repos?per_page=100" \
	--jq '.[] | {name, full_name, owner: {login: .owner.login, avatar_url: .owner.avatar_url}, description, html_url, ssh_url, clone_url, default_branch, homepage, language, stargazers_count, forks_count, size, has_pages, is_template, fork, archived, topics, license: (if .license then {spdx_id: .license.spdx_id} else null end), pushed_at, created_at}' > "$T/repos"
while read -r repo <&3; do
	r=$(jq -r .name <<<"$repo")
	gh api -H 'Accept: application/vnd.github.html+json' "repos/$U/$r/readme" > "$T/readme" 2>/dev/null || : > "$T/readme"
	gh api -H 'Accept: application/vnd.github.html+json' "repos/$U/$r/releases?per_page=6" \
		--jq '[.[] | {name, tag_name, draft, prerelease, published_at, body_html, assets: [.assets[] | {name, size, download_count, browser_download_url}]}]' > "$T/releases"
	gh api "repos/$U/$r/actions/runs?per_page=10" \
		--jq '[.workflow_runs[] | {name, head_branch, status, conclusion, created_at, html_url}]' > "$T/runs" 2>/dev/null || echo '[]' > "$T/runs"
	# The repo list doesn't say what a fork was forked from; one call per fork does.
	parent=null
	if [ "$(jq .fork <<<"$repo")" = true ]; then parent=$(gh api "repos/$U/$r" --jq '.parent.full_name | tojson'); fi
	jq --rawfile readme "$T/readme" --slurpfile releases "$T/releases" --slurpfile runs "$T/runs" --argjson parent "$parent" \
		'. + {readme: $readme, releases: $releases[0], runs: $runs[0], parent: $parent}' <<<"$repo"
done 3< "$T/repos" | jq -s . > _data/repos.json

# Gist endpoints reject GITHUB_TOKEN, so list anonymously (one call); the page loads file contents from raw_url.
curl -sf "https://api.github.com/users/$U/gists?per_page=100" \
	| jq 'map({id, owner: .owner.login, description, html_url, updated_at, files: [.files[] | {filename, language, raw_url}]})' > _data/gists.json
