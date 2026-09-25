#!/usr/bin/env bash
# Fetches public repos (with README HTML and releases) and gists into _data/ for Jekyll.
set -euo pipefail
U=${GITHUB_REPOSITORY_OWNER:-iund}
T=$(mktemp -d)
mkdir -p _data

gh api --paginate "users/$U/repos?per_page=100" \
	--jq '.[] | {name, description, html_url, homepage, language, stargazers_count, fork}' > "$T/repos"
while read -r repo <&3; do
	r=$(jq -r .name <<<"$repo")
	gh api -H 'Accept: application/vnd.github.html+json' "repos/$U/$r/readme" > "$T/readme" 2>/dev/null || : > "$T/readme"
	gh api "repos/$U/$r/releases?per_page=5" \
		--jq '[.[] | {tag_name, name, html_url, published_at, assets: [.assets[] | {name, browser_download_url}]}]' > "$T/releases"
	jq --rawfile readme "$T/readme" --slurpfile releases "$T/releases" \
		'. + {readme: $readme, releases: $releases[0]}' <<<"$repo"
done 3< "$T/repos" | jq -s . > _data/repos.json

# Gist endpoints reject GITHUB_TOKEN, so fetch anonymously; the page loads file contents from raw_url.
curl -sf "https://api.github.com/users/$U/gists?per_page=100" \
	| jq 'map({id, description, html_url, updated_at, files: [.files[] | {filename, language, raw_url}]})' > _data/gists.json
