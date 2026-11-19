# github.jq — the stateful half of tests/fixtures/fake-gh/gh.
#
# One jq process serves a whole fake request: resolve the planned override (if
# any), otherwise run the stateful handler for the path, and return
#
#   <new-state>      (line 1, compact JSON — the caller persists it)
#   <response>       (line 2, compact JSON — {status, body} exactly like the
#                     real gateway output)
#
# Keeping this in jq instead of bash means the stub forks jq once per request
# rather than five times, which is what keeps tests/scripts.test.sh inside its
# runtime budget. Inputs: --slurpfile plan, --slurpfile state, --slurpfile req
# (the request body; [] when the request carried none), --arg method, --arg path.

def done($body; $state): {response: {status: 200, body: $body}, state: $state};

# The stateful GitHub double: current state in, response (and possibly the
# updated state) out. null when no handler covers the method+path, so the
# caller falls back to the plan's default.
def handle($m; $p; $body; $s):
	if ($p | test("^repos/[^/]+/[^/]+$")) then
		if $m == "GET" then
			done({
				full_name: "owner/repo",
				default_branch: $s.default_branch,
				permissions: {admin: $s.admin},
				security_and_analysis: {secret_scanning: {status: $s.secret_scanning}}
			}; $s)
		elif $m == "PATCH" then
			# Secret scanning has no dedicated settings endpoint: it rides on the
			# repo object's security_and_analysis block.
			($body.security_and_analysis.secret_scanning.status // null) as $new
			| ($s | if $new == null then . else .secret_scanning = $new end) as $s2
			| done({full_name: "owner/repo", security_and_analysis: {secret_scanning: {status: $s2.secret_scanning}}}; $s2)
		else null end
	elif ($p | test("^repos/[^/]+/[^/]+/branches/[^/]+/protection$")) then
		if $m == "GET" then
			if ($s.protection // null) == null then
				{response: {status: 404, body: {message: "Branch not protected"}}}
			else
				done($s.protection; $s)
			end
		elif $m == "PUT" then
			# The endpoint replaces the whole protection object, so the stub stores
			# what it was sent — including enforce_admins, which the real API takes
			# as a boolean but reports as {"enabled": ...}.
			($body | {
				required_status_checks: (.required_status_checks // null),
				required_pull_request_reviews: (.required_pull_request_reviews // null),
				enforce_admins: (if (.enforce_admins | type) == "object" then .enforce_admins else {enabled: (.enforce_admins // false)} end),
				restrictions: (.restrictions // null)
			}) as $protection
			| {response: {status: 200, body: {message: "Branch protection updated"}}, state: ($s | .protection = $protection)}
		else null end
	elif ($p | test("^repos/[^/]+/[^/]+/rules/branches/[^/]+$")) then
		if $m == "GET" then done(($s.rules // []); $s) else null end
	elif ($p | test("^repos/[^/]+/[^/]+/vulnerability-alerts$")) then
		if $m == "GET" then
			if $s.vulnerability_alerts == "enabled" then
				{response: {status: 204, body: null}}
			else
				{response: {status: 404, body: {message: "Not Found"}}}
			end
		elif $m == "PUT" then
			{response: {status: 204, body: null}, state: ($s | .vulnerability_alerts = "enabled")}
		elif $m == "DELETE" then
			{response: {status: 204, body: null}, state: ($s | .vulnerability_alerts = "disabled")}
		else null end
	elif ($p | test("^repos/[^/]+/[^/]+/code-scanning/default-setup$")) then
		if $m == "GET" then
			done({state: $s.code_scanning, query_suite: "default", languages: ["bash"]}; $s)
		elif $m == "PATCH" then
			($s | .code_scanning = "configured") as $s2
			| done({state: $s2.code_scanning}; $s2)
		else null end
	elif ($p | test("^repos/[^/]+/[^/]+/code-scanning/analyses$")) then
		if $m == "GET" then
			# created_at is derived from the real clock so the recency window in
			# evaluate.jq can be exercised: analyses_age_days shifts the newest
			# analysis into the past (0 = a fresh run).
			done([
				range(0; ($s.analyses // 0))
				| {id: ., state: "completed", created_at: ((now - (($s.analyses_age_days // 0) * 86400)) | todate)}
			]; $s)
		else null end
	elif ($p | test("^repos/[^/]+/[^/]+/community/profile$")) then
		if $m != "GET" then null
		elif ($s.community_profile // "ok") == "unavailable" then
			{response: {status: 404, body: {message: "Not Found"}}}
		else
			done({
				health_percentage: $s.health_percentage,
				files: {
					readme: (if ($s.files | index("README.md")) != null then {path: "README.md", html_url: "https://example.invalid/README.md"} else null end),
					code_of_conduct: (if ($s.files | index("CODE_OF_CONDUCT.md")) != null then {path: "CODE_OF_CONDUCT.md", name: "Contributor Covenant"} else null end),
					contributing: (if ($s.files | index("CONTRIBUTING.md")) != null then {path: "CONTRIBUTING.md", html_url: "https://example.invalid/CONTRIBUTING.md"} else null end),
					license: (if ($s.files | index("LICENSE")) != null then {path: "LICENSE", spdx_id: "MIT"} else null end),
					issue_template: (if ([$s.files[] | select(startswith(".github/ISSUE_TEMPLATE/"))] | length) > 0 then {path: ".github/ISSUE_TEMPLATE/bug_report.md"} else null end),
					pull_request_template: (if ($s.files | index(".github/PULL_REQUEST_TEMPLATE.md")) != null then {path: ".github/PULL_REQUEST_TEMPLATE.md"} else null end)
				}
			}; $s)
		end
	elif ($p | test("^repos/[^/]+/[^/]+/contents/.+$")) then
		($p | capture("^repos/[^/]+/[^/]+/contents/(?<path>.+)$").path) as $file
		| if $m == "GET" then
			if ($s.files | index($file)) != null then
				done({type: "file", path: $file, name: $file}; $s)
			elif ([$s.files[] | select(startswith($file + "/"))] | length) > 0 then
				done([$s.files[] | select(startswith($file + "/")) | {type: "file", path: .}]; $s)
			else
				{response: {status: 404, body: {message: "Not Found"}}}
			end
		elif $m == "PUT" then
			{
				response: {status: 201, body: {content: {path: $file}, commit: {sha: "cafebabe"}}},
				state: ($s | .files = (((.files // []) + [$file]) | unique))
			}
		else null end
	elif ($p | test("^repos/[^/]+/[^/]+/git/ref/heads/.+$")) then
		if $m == "GET" then
			done({ref: "refs/heads/x", object: {sha: $s.head_sha, type: "commit"}}; $s)
		else null end
	elif ($p | test("^repos/[^/]+/[^/]+/git/refs$")) then
		if $m == "POST" then
			done({ref: $body.ref, object: {sha: $body.object.sha}}; $s)
		else null end
	elif ($p | test("^repos/[^/]+/[^/]+/pulls$")) then
		if $m == "POST" then
			done({number: 1, html_url: "https://example.invalid/pull/1"}; $s)
		else null end
	elif ($p | test("^licenses/[^/]+$")) then
		if $m == "GET" then
			($p | capture("^licenses/(?<key>[^/]+)$").key) as $key
			| done({
				key: $key,
				name: "MIT License",
				spdx_id: "MIT",
				body: "MIT License\n\nCopyright (c) [year] [fullname]\n\nPermission is hereby granted, free of charge.\n"
			}; $s)
		else null end
	else null end;

($plan[0] // {}) as $pl
| ($state[0] // {}) as $s0
| ($req[0] // {}) as $body
| ($method) as $m
| ($path | ltrimstr("/")) as $p
| "\($m) \($path)" as $key
| ($pl.responses[$key] // null) as $entry
| ($s0._seq // {}) as $seq
| (if $entry == null then "none"
	elif (($entry | type) == "object" and ($entry | has("sequence"))) then "sequence"
	else "single" end) as $mode
| (if $mode == "sequence" then
		($seq[$key] // 0) as $index
		| ($entry.sequence | length) as $length
		| ($index | if . < ($length - 1) then . else ($length - 1) end) as $use
		| {
			response: $entry.sequence[$use],
			state: ($s0 | ._seq = ($seq | .[$key] = ($index + 1)))
		}
	elif $mode == "single" then
		{response: $entry, state: $s0}
	else
		(handle($m; $p; $body; $s0) // {
			response: ($pl.default // {status: 404, body: {message: "Not Found"}}),
			state: $s0
		})
	end) as $result
| ($result.state // $s0) as $new_state
| $new_state,
	(if ($result.response | type) == "object" then
		{status: ($result.response.status // 200), body: ($result.response.body // null)}
	else
		{status: 500, body: {message: "fake-gh: malformed planned response"}}
	end)
