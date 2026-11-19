# evaluate.jq — the policy half of git-best-practice-check.
#
# Pure: no I/O, no `gh`, no clocks, no environment. Evidence JSON goes in on
# stdin, a check object comes out:
#
#   {id, practice, status, evidence: [string...], remediable}
#
# The one time-dependent rule (code-scanning recency) takes the current time as
# an input — `--argjson now <epoch-seconds>` — instead of reading a clock, so
# the same evidence always yields the same verdict. Without `now` that rule
# reports `unknown` rather than guessing.
#
# status is one of pass | fail | pending | not-available | unknown:
#   pass          — the practice is satisfied
#   fail          — the practice is not satisfied and can be remediated
#   pending       — requested, not yet effective (async GitHub work)
#   not-available — the API/plan cannot express this practice; not the user's fault
#   unknown       — the evidence could not be read; never rendered as pass or fail
#
# `remediable` is true only for `fail`, so an unknown/permission-gapped practice
# can never be offered for remediation.
#
# Checklist parity: SKILL.md lists the same ids. `jq -n -f evaluate.jq
# --arg mode list-ids` prints them, and skill-md.test.mts asserts the two sets
# are equal.
#
# Evidence bundle shape (per id, always carrying slug + default_branch):
#   branch-protection  {slug, default_branch, protection: {status, body}, rules: {status, body}}
#   dependabot-alerts  {slug, default_branch, vulnerability_alerts: {status, body}}
#   secret-scanning    {slug, default_branch, repo: {status, body}}
#   code-scanning      {slug, default_branch, default_setup: {status, body}, analyses: {status, body}}
#   community-*        {slug, default_branch, profile: {status, body}, probes: [{path, status, body}]}

def practices:
	[
		{id: "branch-protection", practice: "Main branch protected (1+ review, admins not exempt)"},
		{id: "dependabot-alerts", practice: "Dependabot alerts enabled"},
		{id: "code-scanning", practice: "Code scanning alerts enabled"},
		{id: "secret-scanning", practice: "Secret scanning alerts enabled"},
		{id: "community-readme", practice: "Community standards: README"},
		{id: "community-code-of-conduct", practice: "Community standards: code of conduct"},
		{id: "community-contributing", practice: "Community standards: contributing guide"},
		{id: "community-license", practice: "Community standards: license"},
		{id: "community-security-policy", practice: "Community standards: security policy (SECURITY.md)"},
		{id: "community-issue-templates", practice: "Community standards: issue templates"},
		{id: "community-pull-request-template", practice: "Community standards: pull request template"}
	];

def community_specs:
	[
		{id: "community-readme", field: "readme"},
		{id: "community-code-of-conduct", field: "code_of_conduct"},
		{id: "community-contributing", field: "contributing"},
		{id: "community-license", field: "license"},
		{id: "community-security-policy", field: null},
		{id: "community-issue-templates", field: "issue_template"},
		{id: "community-pull-request-template", field: "pull_request_template"}
	];

def as_array: if type == "array" then . else [] end;

# Wall clock, supplied by the caller (`--argjson now`). null when absent.
def now_epoch: ($ARGS.named.now // null);

# An analysis older than this many days is history, not an active scanner, so
# `not-configured` + stale analyses does not satisfy the code-scanning practice.
# 90 days is the documented window; change it here and nowhere else.
def code_scanning_max_age_days: 90;

def status_of: (.status // 0);

def http_ok: status_of >= 200 and status_of < 300;

def denied: status_of == 401 or status_of == 403;

# --- branch protection -----------------------------------------------------

def active_pr_rules($rules):
	[
		$rules[]
		| select((.type // "") == "pull_request")
		| select((.enforcement // "active") == "active")
	];

def rules_min_reviews($rules):
	[active_pr_rules($rules)[] | (.parameters.required_approving_review_count // .parameters.min_approving_review_count // 0)]
	| if length == 0 then 0 else max end;

def rules_bypass($rules): [active_pr_rules($rules)[] | (.bypass_actors // [])[]];

def required_checks($p):
	(($p.required_status_checks // {})) as $rsc
	| ([($rsc.checks // [])[] | .context] + [($rsc.contexts // [])[]] | unique);

def eval_branch_protection($ev):
	($ev.protection // {status: 0, body: null}) as $prot
	| ($ev.rules // {status: 0, body: null}) as $rules_resp
	| (($rules_resp.body // []) | as_array) as $rules
	| (($prot.body // {})) as $p
	| ($p.required_pull_request_reviews.required_approving_review_count // 0) as $reviews
	| ($p.enforce_admins.enabled // false) as $admins
	| (required_checks($p)) as $checks
	| (rules_min_reviews($rules)) as $rule_reviews
	| (rules_bypass($rules)) as $bypass
	| (active_pr_rules($rules) | length) as $rule_count
	| [
		"GET /repos/\($ev.slug)/branches/\($ev.default_branch)/protection -> \($prot.status)",
		"GET /repos/\($ev.slug)/rules/branches/\($ev.default_branch) -> \($rules_resp.status)"
	] as $probe
	| if $prot.status == 200 then
		(
			[
				"required_approving_review_count=\($reviews)",
				"enforce_admins.enabled=\($admins)"
			]
			+ (if ($checks | length) > 0 then ["required_checks=\($checks | join(","))"] else [] end)
			+ (if ($bypass | length) > 0 then ["ruleset bypass_actors=\($bypass | tojson)"] else [] end)
		) as $facts
		| if $reviews >= 1 and $admins then
			{status: "pass", evidence: ($probe + $facts)}
		elif $reviews < 1 then
			{status: "fail", evidence: ($probe + $facts + ["classic protection requires \($reviews) approving review(s); the checklist requires at least 1"])}
		elif $rule_count > 0 and $rule_reviews >= 1 and ($bypass | length) == 0 then
			{status: "pass", evidence: ($probe + $facts + ["admins covered by an active ruleset rule with \($rule_reviews) required review(s) and no bypass actors"])}
		else
			{status: "fail", evidence: ($probe + $facts + ["admins exempt: enforce_admins.enabled=false and no covering ruleset rule"])}
		end
	elif $prot.status == 404 then
		[
			"GET /repos/\($ev.slug)/rules/branches/\($ev.default_branch) -> \($rules_resp.status) (protection may live in rulesets)",
			"ruleset pull_request rules=\($rule_count)",
			"ruleset required_approving_review_count=\($rule_reviews)"
		] as $rfacts
		| if $rules_resp.status == 200 then
			if $rule_reviews >= 1 and ($bypass | length) == 0 then
				{status: "pass", evidence: ($rfacts + (if ($checks | length) > 0 then ["required_checks=\($checks | join(","))"] else [] end))}
			elif ($bypass | length) > 0 then
				{status: "fail", evidence: ($rfacts + ["ruleset bypass_actors=\($bypass | tojson) exempts actors from the review requirement"])}
			else
				{status: "fail", evidence: ($rfacts + ["no active pull_request ruleset rule requires an approving review"])}
			end
		elif $rules_resp.status == 404 then
			{status: "fail", evidence: ($probe + ["no branch protection and no ruleset covers this branch"])}
		elif ($rules_resp.status == 401 or $rules_resp.status == 403) then
			{status: "unknown", evidence: ($probe + ["cannot read branch rules (permission gap); the protection state is unknown"])}
		else
			{status: "unknown", evidence: ($probe + ["unexpected response from the branch rules endpoint"])}
		end
	elif ($prot.status == 401 or $prot.status == 403) then
		{status: "unknown", evidence: ($probe + ["cannot read branch protection (permission gap)"])}
	else
		{status: "unknown", evidence: ($probe + ["unexpected response from the branch protection endpoint"])}
	end;

# Missing or unparseable: null (the caller decides what that means).
def analysis_epoch($a):
	(($a.created_at // $a.updated_at // null)) as $stamp
	| if ($stamp | type) == "string" then (try ($stamp | fromdateiso8601) catch null) else null end;

def latest_analysis_epoch($analyses):
	[$analyses[] | analysis_epoch(.)] | map(select(. != null))
	| if length == 0 then null else max end;

# --- security features -----------------------------------------------------

def eval_dependabot_alerts($ev):
	($ev.vulnerability_alerts // {status: 0, body: null}) as $v
	| ["GET /repos/\($ev.slug)/vulnerability-alerts -> \($v.status)"] as $probe
	| if ($v | http_ok) then
		{status: "pass", evidence: ($probe + ["dependabot alerts are enabled"])}
	elif $v.status == 404 then
		{status: "fail", evidence: ($probe + ["dependabot alerts are disabled"])}
	elif ($v | denied) then
		{status: "not-available", evidence: ($probe + ["dependabot alerts are not available to this token or plan"])}
	else
		{status: "unknown", evidence: $probe}
	end;

def eval_secret_scanning($ev):
	($ev.repo // {status: 0, body: null}) as $r
	| (($r.body // {}).security_and_analysis.secret_scanning.status) as $state
	| ["GET /repos/\($ev.slug) -> \($r.status) (security_and_analysis)"] as $probe
	| if $r.status == 401 or $r.status == 403 then
		{status: "not-available", evidence: ($probe + ["secret scanning settings are not exposed to this token or plan"])}
	elif $r.status != 200 then
		{status: "unknown", evidence: $probe}
	elif $state == "enabled" then
		{status: "pass", evidence: ($probe + ["secret_scanning.status=enabled"])}
	else
		{status: "fail", evidence: ($probe + ["secret_scanning.status=\($state // "absent")"])}
	end;

def eval_code_scanning($ev):
	($ev.default_setup // {status: 0, body: null}) as $ds
	| (($ev.analyses // {status: 0, body: []}).body) as $raw
	| ($raw | as_array) as $list
	| (if ($raw | type) == "array" then ($list | length)
		elif ($raw | type) == "object" then (($raw.total_count) // 0)
		else 0 end) as $runs
	| (latest_analysis_epoch($list)) as $latest
	| (if $latest == null or now_epoch == null then null
		else (now_epoch - $latest) / 86400 | floor end) as $age
	| ["GET /repos/\($ev.slug)/code-scanning/default-setup -> \($ds.status)"] as $probe
	| (($ds.body // {}).state) as $state
	| if ($ds | http_ok) and $state == "configured" then
		if $runs > 0 then
			{
				status: "pass",
				evidence: ($probe + ["state=configured", "completed analyses=\($runs)"]
					+ (if $age == null then [] else ["newest analysis is \($age) days old"] end))
			}
		else
			{status: "pending", evidence: ($probe + ["state=configured", "completed analyses=0 (waiting for the first CodeQL run)"])}
		end
	elif ($ds | http_ok) and $state == "not-configured" then
		# Default setup off: a scanning workflow can still be uploading results
		# to the same alerts, so the checklist accepts either. What it does not
		# accept is history alone — an analysis that stopped arriving months ago
		# means nothing is scanning now, so the newest analysis is compared with
		# the documented window (code_scanning_max_age_days).
		if $runs == 0 then
			{status: "fail", evidence: ($probe + ["state=not-configured", "completed analyses=0 (no default setup and no scanning workflow)"])}
		elif $age == null then
			{
				status: "unknown",
				evidence: ($probe + [
					"state=not-configured (scanning comes from a workflow, not default setup)",
					"completed analyses=\($runs) but without a usable timestamp, so recency cannot be judged"
				])
			}
		elif $age > code_scanning_max_age_days then
			{
				status: "fail",
				evidence: ($probe + [
					"state=not-configured (scanning comes from a workflow, not default setup)",
					"newest analysis is \($age) days old",
					"no analysis within the last \(code_scanning_max_age_days) days (window: code_scanning_max_age_days); nothing is scanning this repository right now"
				])
			}
		else
			{
				status: "pass",
				evidence: ($probe + [
					"state=not-configured (scanning comes from a workflow, not default setup)",
					"completed analyses=\($runs)",
					"newest analysis is \($age) days old (within the \(code_scanning_max_age_days)-day window)"
				])
			}
		end
	elif ($ds | denied) or $ds.status == 404 then
		{status: "not-available", evidence: ($probe + ["code scanning is not available for this repository (plan or licensing)"])}
	elif ($ds | http_ok) then
		{status: "unknown", evidence: ($probe + ["state=\($state // "absent")"])}
	else
		{status: "unknown", evidence: $probe}
	end;

# --- community standards ---------------------------------------------------

def probe_desc:
	if http_ok then
		"\(.path) exists (type=\(.body.type // "unknown"))"
		+ (if (.body.type // "") == "symlink" then " -> \(.body.target // "?")" else "" end)
	else
		"\(.path) -> \(.status)"
	end;

def eval_community($ev; $spec):
	($ev.profile // {status: 0, body: null}) as $profile
	| (($ev.probes // []) | as_array) as $probes
	| (($profile.body // {}).files // {}) as $files
	| ($spec.field) as $field
	| (if $field != null and $profile.status == 200 then $files[$field] else null end) as $by_profile
	| (if $profile.status == 200 then
		["community/profile -> 200 (health_percentage=\((($profile.body // {}).health_percentage) // "unknown"))"]
	elif $profile.status == 404 then
		["community/profile -> 404 (unavailable, e.g. a fork); falling back to contents lookups"]
	else
		["community/profile -> \($profile.status)"]
	end) as $profile_note
	| (if $profile.status == 200 and $field != null then ["community/profile files.\($field) = \($by_profile | tojson)"] else [] end) as $field_note
	| if $by_profile != null then
		{status: "pass", evidence: ($profile_note + $field_note)}
	else
		([$probes[] | select(http_ok)]) as $hits
		| ([$probes[] | select(denied)]) as $gaps
		| if ($hits | length) > 0 then
			{status: "pass", evidence: ($profile_note + $field_note + [$hits[] | probe_desc])}
		elif ($gaps | length) > 0 then
			{status: "unknown", evidence: ($profile_note + $field_note + [$probes[] | probe_desc] + ["permission gap on the contents lookup; presence is unknown"])}
		else
			{status: "fail", evidence: ($profile_note + $field_note + [$probes[] | probe_desc])}
		end
	end;

# --- dispatch --------------------------------------------------------------

def evaluate($id; $ev):
	(practices | map(select(.id == $id)) | .[0]) as $p
	| if $p == null then
		error("unknown check id: \($id)")
	else
		(if $id == "branch-protection" then eval_branch_protection($ev)
		elif $id == "dependabot-alerts" then eval_dependabot_alerts($ev)
		elif $id == "code-scanning" then eval_code_scanning($ev)
		elif $id == "secret-scanning" then eval_secret_scanning($ev)
		else
			(community_specs | map(select(.id == $id)) | .[0]) as $spec
			| if $spec == null then error("no community rule for \($id)") else eval_community($ev; $spec) end
		end) as $r
		| {id: $id, practice: $p.practice, status: $r.status, evidence: $r.evidence, remediable: ($r.status == "fail")}
	end;

($ARGS.named.mode // "evaluate") as $mode
| if $mode == "list-ids" then
	(practices | map(.id)[])
elif $mode == "list" then
	practices
else
	evaluate($ARGS.named.id; .)
end
