# branch-protection.jq — read-modify-write body for
# PUT /repos/{owner}/{repo}/branches/{branch}/protection
#
# That endpoint REPLACES the whole protection config and requires all four
# top-level fields. This filter takes the current config (`$current`, `{}` when
# the branch is unprotected) and returns the checklist settings merged into it:
# 1+ approving review, admins enforced, every pre-existing status check and
# restriction preserved. It never invents a status check.

def logins($items):
	[($items // [])[] | if type == "object" then (.login // .slug // empty) else . end];

def rewrap($value; $shape):
	if ($value // null) == null then null else $shape end;

def protection_payload($current):
	($current.required_status_checks // null) as $checks
	| ($current.required_pull_request_reviews // {}) as $reviews
	| ($current.restrictions // null) as $restrictions
	| {
		required_status_checks: rewrap($checks; {
			strict: ($checks.strict // false),
			contexts: ($checks.contexts // []),
			checks: ($checks.checks // [])
		}),
		enforce_admins: true,
		required_pull_request_reviews: ({
			dismiss_stale_reviews: ($reviews.dismiss_stale_reviews // false),
			require_code_owner_reviews: ($reviews.require_code_owner_reviews // false),
			required_approving_review_count: 1,
			require_last_push_approval: ($reviews.require_last_push_approval // false)
		}
		+ (rewrap(($reviews.dismissal_restrictions // null); {
			dismissal_restrictions: {
				users: logins($reviews.dismissal_restrictions.users),
				teams: logins($reviews.dismissal_restrictions.teams)
			} }) // {})
		+ (rewrap(($reviews.bypass_pull_request_allowances // null); {
			bypass_pull_request_allowances: {
				users: logins($reviews.bypass_pull_request_allowances.users),
				teams: logins($reviews.bypass_pull_request_allowances.teams),
				apps: logins($reviews.bypass_pull_request_allowances.apps)
			} }) // {})),
		restrictions: rewrap($restrictions; {
			users: logins($restrictions.users),
			teams: logins($restrictions.teams),
			apps: logins($restrictions.apps)
		})
	};

protection_payload($current)
