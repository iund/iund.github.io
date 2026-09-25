#!/usr/bin/env bash
# Fetches public repos (README HTML, releases, Actions runs) and gists (file contents are loaded by the page) into _data/ for Jekyll.
set -euo pipefail
U=${GITHUB_REPOSITORY_OWNER:-iund}
T=$(mktemp -d)
mkdir -p _data

gh api --paginate "users/$U/repos?per_page=100" \
	--jq '.[] | {name, description, html_url, ssh_url, clone_url, default_branch, homepage, language, stargazers_count, fork}' > "$T/repos"
while read -r repo <&3; do
	r=$(jq -r .name <<<"$repo")
	gh api -H 'Accept: application/vnd.github.html+json' "repos/$U/$r/readme" > "$T/readme" 2>/dev/null || : > "$T/readme"
	gh api "repos/$U/$r/releases?per_page=5" \
		--jq '[.[] | {tag_name, name, html_url, published_at, assets: [.assets[] | {name, browser_download_url}]}]' > "$T/releases"
	gh api "repos/$U/$r/actions/runs?per_page=10" \
		--jq '[.workflow_runs[] | {name, head_branch, status, conclusion, created_at, html_url}]' > "$T/runs" 2>/dev/null || echo '[]' > "$T/runs"
	jq --rawfile readme "$T/readme" --slurpfile releases "$T/releases" --slurpfile runs "$T/runs" \
		'. + {readme: $readme, releases: $releases[0], runs: $runs[0]}' <<<"$repo"
done 3< "$T/repos" | jq -s . > _data/repos.json

# Gist endpoints reject GITHUB_TOKEN, so list anonymously (one call); the page loads file contents from raw_url.
curl -sf "https://api.github.com/users/$U/gists?per_page=100" \
	| jq 'map({id, owner: .owner.login, description, html_url, updated_at, files: [.files[] | {filename, language, raw_url}]})' > _data/gists.json
