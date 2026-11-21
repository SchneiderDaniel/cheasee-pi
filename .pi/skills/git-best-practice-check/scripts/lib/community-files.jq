# community-files.jq — scaffold bodies for the missing community standards
# files. `$name` is the repository name, used for the README/CONTRIBUTING
# headings. LICENSE is not built here: it comes from GET /licenses/{key} so the
# text is GitHub's own template, substituted by the caller.

def community_body($path; $name):
	if $path == "README.md" then
		"# \($name)\n\n<!-- One paragraph: what this project does, who it is for, how to get started. -->\n\n## Getting started\n\nSee CONTRIBUTING.md for the development setup.\n\n## License\n\nSee LICENSE.\n"
	elif $path == "CODE_OF_CONDUCT.md" then
		"# Contributor Covenant Code of Conduct\n\n## Our pledge\n\nWe as members, contributors, leaders pledge to make participation in our community a harassment-free experience for everyone.\n\n## Our standards\n\nBehaviour that contributes to a positive environment includes empathy, respect for differing opinions, graceful acceptance of constructive feedback. Unacceptable behaviour includes harassment, derogatory comments, publishing private information.\n\n## Enforcement\n\nReport unacceptable behaviour to the repository maintainers. All complaints will be reviewed promptly, fairly.\n\n## Attribution\n\nAdapted from the Contributor Covenant, version 2.1.\n"
	elif $path == "CONTRIBUTING.md" then
		"# Contributing to \($name)\n\n## Before you start\n\nOpen an issue that describes the change you intend to make. Small, focused pull requests review faster than large ones.\n\n## Development loop\n\n1. Branch from the default branch.\n2. Make the change, add tests.\n3. Run the project test command plus the type-check.\n4. Open a pull request that states the problem plus the verification you ran.\n\n## Commit messages\n\nUse an imperative subject line, explain the why in the body.\n"
	elif $path == "SECURITY.md" then
		"# Security policy\n\n## Supported versions\n\nThe latest release on the default branch receives security fixes.\n\n## Reporting a vulnerability\n\nDo not open a public issue for a suspected vulnerability. Use GitHub private vulnerability reporting (Security tab, \"Report a vulnerability\") or contact the maintainers directly. Expect an acknowledgement within 7 days.\n\n## Scope\n\nSecrets, authentication, dependency supply chain, anything that can leak user data.\n"
	elif $path == ".github/PULL_REQUEST_TEMPLATE.md" then
		"## Problem\n\nWhat problem does this change solve? Link the issue.\n\n## Change\n\nWhat did you change, why this way?\n\n## Verification\n\n- [ ] Tests added or updated\n- [ ] Test command passes locally\n- [ ] Documentation updated (if behaviour changed)\n"
	elif $path == ".github/ISSUE_TEMPLATE/feature_request.md" then
		"---\nname: Feature request\nabout: Suggest an idea for this project\ntitle: ''\nlabels: enhancement\n---\n\n## Problem\n\nWhat problem are you trying to solve?\n\n## Proposed solution\n\nWhat should happen instead?\n\n## Alternatives considered\n\nWhat else did you try or consider?\n"
	elif $path == ".github/ISSUE_TEMPLATE/bug_report.md" then
		"---\nname: Bug report\nabout: Report a defect in this project\ntitle: ''\nlabels: bug\n---\n\n## What happened\n\nA clear description of the defect.\n\n## Steps to reproduce\n\n1.\n2.\n\n## Expected behaviour\n\nWhat did you expect instead?\n\n## Environment\n\nVersion, platform, anything else that helps.\n"
	else empty end;

community_body($path; $name)
