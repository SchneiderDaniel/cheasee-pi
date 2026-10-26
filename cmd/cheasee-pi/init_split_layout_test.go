package main

import (
	"fmt"
	"path/filepath"
	"strings"
	"testing"
)

// ──────────────────────────────────────────────
// Test-file layout invariant + repo-wide size gate
// ──────────────────────────────────────────────

// testSplitFiles are the per-subject test files produced by the init_test.go
// split. New per-subject files must be added here; the checker below reports
// any decl inside them that is not covered by an inventory entry or rule.
var testSplitFiles = []string{
	"init_helpers_test.go",
	"init_clone_test.go",
	"init_clone_flow_test.go",
	"init_clone_realgit_test.go",
	"init_dockercheck_test.go",
	"init_usecase_test.go",
	"init_usecase_probe_test.go",
	"init_auth_test.go",
	"init_auth_flow_test.go",
	"init_auth_reauth_test.go",
	"init_scaffold_test.go",
	"init_prompt_test.go",
	"init_skillrepos_test.go",
	"init_skillrepos_loop_test.go",
	"init_skillrepos_terms_test.go",
	"init_skillrepos_usecase_test.go",
	"pi_skeleton_test.go",
	"catalog_test.go",
	"catalog_remote_test.go",
	"catalog_authadd_test.go",
	"catalog_initkeys_test.go",
}

// initHelperDecls pins the cross-subject helpers to init_helpers_test.go.
// The rest of the original init_test.go helpers moved to helpers_test.go
// (mocks, seam stubs, initDeps) and testutil/ (SetGitConfig,
// RedirectConfigHome, ReadEnvFile, ReadSettingsRaw, CaptureStderr) when main
// consolidated test scaffolding; only the auth helpers remain (loadAuthJSON
// became readAuthJSON when the typed codec died — tests now read the
// raw-map dialect).
var initHelperDecls = map[string]string{
	"func:authJSONExists": "init_helpers_test.go",
	"func:authJSONBytes":  "init_helpers_test.go",
	"func:readAuthJSON":   "init_helpers_test.go",
	"func:authField":      "init_helpers_test.go",
	"func:providerKey":    "init_helpers_test.go",
}

// runInitFlowDecls pins the TestRunInit_* decls (colliding prefix) by flow
// stage: auth seam, scaffold-only orchestration with mockAuthenticator.
var runInitFlowDecls = map[string]string{
	"func:TestRunInit_FullFlow":                        "init_auth_flow_test.go",
	"func:TestRunInit_NoGitHubFlag":                    "init_auth_flow_test.go",
	"func:TestRunInit_ErrUnsupportedFallsBackToLegacy": "init_auth_flow_test.go",
	"func:TestRunInit_ContextCancelledMidFlow":         "init_auth_flow_test.go",
	"func:TestRunInit_GitHubFlowClonesWorktree":        "init_prompt_test.go",
	"func:TestRunInit_NoGitHubLegacySkipsGitInit":      "init_prompt_test.go",
	"func:TestRunInit_OverviewAndPlainPrompts":         "init_prompt_test.go",
	"func:TestRunInit_NoInputSkipsOverview":            "init_prompt_test.go",
	"func:TestRunInit_NoGitHubSkipsOverview":           "init_prompt_test.go",
	"func:TestRunInit_ReauthSkipsOverview":             "init_prompt_test.go",
	"func:TestRunInit_NonEmptyFolderSkipsOverview":     "init_prompt_test.go",
}

// skillRepoUseCaseDecls pins the TestInitUseCase_* skill-repo e2e decls that
// share no common prefix (the TestInitUseCase_SkillRepo rule covers the rest).
var skillRepoUseCaseDecls = map[string]string{
	"func:TestInitUseCase_NoSkillReposScaffoldByteIdentical": "init_skillrepos_usecase_test.go",
	"func:TestInitUseCase_NoInputSkillRepoFlagsNoPrompts":    "init_skillrepos_usecase_test.go",
	"func:TestInitUseCase_NoGitHubRecordsSkillRepos":         "init_skillrepos_usecase_test.go",
	"func:TestInitUseCase_ReauthLeavesSkillReposUntouched":   "init_skillrepos_usecase_test.go",
}

// testSplitRules map decl name prefixes to their subject file. Rules are
// checked in order; more specific prefixes must come first (e.g.
// TestRunInitScaffold before TestRunInitProbe).
var testSplitRules = []prefixRule{
	{"TestGitCloneWorktree_exactArgv", "init_clone_test.go"},
	{"TestGitCloneWorktree_masterDefaultAttached", "init_clone_test.go"},
	{"TestGitCloneWorktree_detachedHeadFallback", "init_clone_test.go"},
	{"TestGitCloneWorktree_shorthandNormalizedToHTTPS", "init_clone_test.go"},
	{"TestGitCloneWorktree_scpStyleNormalizedToHTTPS", "init_clone_test.go"},
	{"TestGitCloneWorktree_realGit", "init_clone_realgit_test.go"},
	{"TestGitCloneWorktree_e2eWorktreeFix", "init_clone_realgit_test.go"},
	{"TestGitCloneWorktree", "init_clone_flow_test.go"},
	{"TestRemoveInitResidue", "init_clone_realgit_test.go"},
	{"TestRedactToken", "init_clone_test.go"},
	{"TestCanonicalRepoURL", "init_clone_test.go"},
	{"TestRunInitAuth", "init_auth_test.go"},
	{"TestRunInitLegacy", "init_auth_flow_test.go"},
	{"TestRunReauth", "init_auth_reauth_test.go"},
	{"TestRunInitE", "init_prompt_test.go"},
	{"TestDeviceFlowAuthenticator", "init_auth_test.go"},
	{"TestRunInitScaffold", "init_scaffold_test.go"},
	{"TestGitIgnoreCheaseeSettings", "init_scaffold_test.go"},
	{"TestInitDeps", "init_scaffold_test.go"},
	{"TestInit_SuccessMessage", "init_scaffold_test.go"},
	{"TestEnsurePiSkeleton", "pi_skeleton_test.go"},
	{"TestInitCmd", "init_prompt_test.go"},
	{"TestInitUseCase_Docker", "init_dockercheck_test.go"},
	{"TestInitUseCase_NoDockerCheckFlag", "init_dockercheck_test.go"},
	{"TestInitUseCase_SkillRepo", "init_skillrepos_usecase_test.go"},
	{"TestInitProbe", "init_usecase_probe_test.go"},
	{"TestInitUseCase", "init_usecase_test.go"},
	{"TestCanonicalSkillRepo", "init_skillrepos_test.go"},
	{"TestRecordSkillRepos", "init_skillrepos_test.go"},
	{"TestInitHelp", "init_skillrepos_test.go"},
	{"TestRunInitSkillRepos_InteractiveLoop", "init_skillrepos_loop_test.go"},
	{"TestRunInitSkillRepos_EmptyInputStopsLoop", "init_skillrepos_loop_test.go"},
	{"TestRunInitSkillRepos_InvalidSpecFailsFast", "init_skillrepos_loop_test.go"},
	{"TestRunInitSkillRepos_PromptErrorWrapped", "init_skillrepos_loop_test.go"},
	{"TestRunInitSkillRepos_SeedsDefaultAlongsideExistingCustom", "init_skillrepos_loop_test.go"},
	{"TestRunInitSkillRepos", "init_skillrepos_terms_test.go"},
	{"TestRemoteModelCatalog", "catalog_test.go"},
	{"TestRunAuthAddE", "catalog_authadd_test.go"},
	{"TestRunInitAPIKeys", "catalog_initkeys_test.go"},
}

// wantTestDecls pins the moved Test decls whose names share no distinguishing
// prefix with the sibling they were split into (so a prefixRule cannot route
// them). `want` is consulted before the prefix rules.
var wantTestDecls = map[string]string{
	"func:TestRemoteModelCatalog_ContextCancellationAbortsNoPartialCache": "catalog_remote_test.go",
	"func:TestRemoteModelCatalog_NeverSendsCredentials":                   "catalog_remote_test.go",
	"func:TestRemoteModelCatalog_ShapeVariants":                           "catalog_remote_test.go",
	"func:TestRemoteModelCatalog_EmptyCatalogErrors":                      "catalog_remote_test.go",
	"func:TestRemoteModelCatalog_MalformedCacheFileTreatedAsMiss":         "catalog_remote_test.go",
	"func:TestRemoteModelCatalog_UnknownProviderIdResolves":               "catalog_remote_test.go",
	"func:TestRemoteModelCatalog_ProviderEscapedInURLAndCachePath":        "catalog_remote_test.go",
	"func:TestRemoteModelCatalog_CacheWriteFailureWarnsKeepsResult":       "catalog_remote_test.go",
	"func:TestInitHelp_TerminologyContract":                               "init_skillrepos_terms_test.go",
}

// mergedTestDecls are the decls moved from init_test.go into existing test
// files. The check is one-directional: the moved decls must be present, but
// pre-existing decls in those files are not part of the inventory. All
// config_test.go entries were removed when the typed dialect (Auth +
// MarshalJSON/UnmarshalJSON/Load/Save) collapsed into the raw-map module —
// the codec pins and backward-compat Load tests died with it and their
// contracts re-homed against GitHubToken/ListProviders.
var mergedTestDecls = map[string][]string{
	"embed_test.go": {
		"func:TestExtract_SkipsPiSubtree",
	},
	"template_test.go": {
		"func:TestSettingsScaffold_WritesCorrectContent",
		"func:TestSettingsScaffold_Idempotent",
		"func:TestSettingsScaffold_EmptyValues",
		"func:TestSettingsScaffold_InvalidWorkdir",
		"func:TestSettingsScaffold_ContextCancelled",
	},
}

type prefixRule struct {
	prefix string
	file   string
}

// matchPrefixRule returns the target file of the first rule whose prefix
// matches the decl name, or "" if none match.
func matchPrefixRule(key string, rules []prefixRule) string {
	name := strings.TrimPrefix(key, "func:")
	for _, r := range rules {
		if strings.HasPrefix(name, r.prefix) {
			return r.file
		}
	}
	return ""
}

// checkTestLayout verifies the test-file organization invariants: every decl
// in a subject file is covered by an inventory entry or prefix rule and sits
// in its expected file; every inventory decl exists exactly once; merged-file
// decls are present; every covered file stays package main. Returns a list of
// violations (empty when the layout is clean).
func checkTestLayout(subject []string, want map[string]string, rules []prefixRule, merged map[string][]string) []string {
	var violations []string
	subjectSet := map[string]bool{}
	covered := map[string]bool{}
	for _, f := range subject {
		subjectSet[f] = true
		covered[f] = true
	}
	for f := range merged {
		covered[f] = true
	}

	found := map[string]string{} // decl key -> file it was found in
	byFile := map[string][]string{}
	for f := range covered {
		pkg, keys, err := parseDecls(f)
		if err != nil {
			violations = append(violations, fmt.Sprintf("%s: %v", f, err))
			continue
		}
		if pkg != "main" {
			violations = append(violations, fmt.Sprintf("%s declares package %s; it must stay package main", f, pkg))
		}
		for _, k := range keys {
			if prev, ok := found[k]; ok {
				violations = append(violations, fmt.Sprintf("decl %q found in both %s and %s", k, prev, f))
				continue
			}
			found[k] = f
			byFile[f] = append(byFile[f], k)
		}
	}

	for f, keys := range byFile {
		if !subjectSet[f] {
			continue
		}
		base := filepath.Base(f)
		for _, k := range keys {
			if exp, ok := want[k]; ok {
				if exp != base {
					violations = append(violations, fmt.Sprintf("decl %q is in %s, expected %s", k, base, exp))
				}
				continue
			}
			if ruleFile := matchPrefixRule(k, rules); ruleFile != "" {
				if ruleFile != base {
					violations = append(violations, fmt.Sprintf("decl %q is in %s, expected %s", k, base, ruleFile))
				}
				continue
			}
			violations = append(violations, fmt.Sprintf("decl %q in %s is not covered by the test layout", k, base))
		}
	}

	for k, exp := range want {
		if found[k] == "" {
			violations = append(violations, fmt.Sprintf("inventory decl %q missing from %s", k, exp))
		}
	}

	for f, req := range merged {
		for _, k := range req {
			if filepath.Base(found[k]) != f {
				violations = append(violations, fmt.Sprintf("merged decl %q missing from %s", k, f))
			}
		}
	}
	return violations
}

// ──────────────────────────────────────────────
// up_test.go / up_flow_test.go split
// ──────────────────────────────────────────────

// upSplitFiles are the files produced by the up_test.go / up_flow_test.go
// split: the four new thematic files plus the flow remainder. Any future
// uncatalogued up_*.go test decl fails TestUpFileLayout.
var upSplitFiles = []string{
	"up_helpers_test.go",
	"up_env_test.go",
	"up_env_flags_test.go",
	"up_env_auth_test.go",
	"up_env_redact_test.go",
	"up_orphans_test.go",
	"up_orphans_scan_test.go",
	"up_orphans_claim_test.go",
	"up_workspace_test.go",
	"up_flow_test.go",
	"up_flow_journey_test.go",
}

// wantUpDecls pins the non-Test decls of the up split to their target file.
// Prefix rules cannot cover non-Test decls, so the shared fixtures (single
// home: up_helpers_test.go — enforced by the package-wide namespace and the
// checker's duplicate detection) and the local helpers that moved with their
// test groups are inventoried explicitly.
var wantUpDecls = map[string]string{
	"func:stubUpFlow":          "up_helpers_test.go",
	"func:setUpRun":            "up_helpers_test.go",
	"func:setUpRunMode":        "up_helpers_test.go",
	"func:stubExecPIContainer": "up_helpers_test.go",
	"func:mkWorkspace":         "up_helpers_test.go",
	"func:stubAutoInitDeps":    "up_helpers_test.go",
	"func:stubImageGate":       "up_helpers_test.go",
	"func:stackStates":         "up_helpers_test.go",
	"func:psOutput":            "up_helpers_test.go",
	"func:allStackStates":      "up_helpers_test.go",
	"type:upCapture":           "up_helpers_test.go",
	"type:upExecCapture":       "up_helpers_test.go",
	"type:upFlowImageState":    "up_helpers_test.go",
	"const:upImageMissing,upImagePresent,upImageDaemonError": "up_helpers_test.go",

	"func:indexOfArg":           "up_env_test.go",
	"func:buildEnvFlagsOrFatal": "up_env_flags_test.go",

	"func:workspaceParentFixture": "up_workspace_test.go",
	"func:assertOrderedStderr":    "up_flow_journey_test.go",
}

// upSplitRules map the up test decl name prefixes to their thematic file.
// Prefixes are disjoint, so order is not load-bearing.
var upSplitRules = []prefixRule{
	{"TestRunUpE_nonInitializedRefused", "up_flow_test.go"},
	{"TestRunUpE_dryRun", "up_flow_test.go"},
	{"TestRunUpE_autoInit", "up_flow_test.go"},
	{"TestRunUpE_fullFlowRunsContainer", "up_flow_test.go"},
	{"TestRunUpE", "up_flow_journey_test.go"},
	{"TestExecArgs", "up_env_test.go"},
	{"TestBuildEnvFlags_authGitHubTokenWinsOverProcessEnv", "up_env_flags_test.go"},
	{"TestBuildEnvFlags_resolves", "up_env_flags_test.go"},
	{"TestBuildEnvFlags_aliasDupesCollapseToOneKey", "up_env_flags_test.go"},
	{"TestBuildEnvFlags_unknownProviderPassthrough", "up_env_flags_test.go"},
	{"TestBuildEnvFlags_emptyAuthNoEnvs", "up_env_flags_test.go"},
	{"TestBuildEnvFlags_invalidAuthReturnsWrappedError", "up_env_flags_test.go"},
	{"TestBuildEnvFlags_passthroughEnvVars", "up_env_flags_test.go"},
	{"TestBuildEnvFlags_happyPath", "up_env_flags_test.go"},
	{"TestBuildEnvFlags", "up_env_auth_test.go"},
	{"TestAllEnvVarNames", "up_env_redact_test.go"},
	{"TestProviderPassthroughNames", "up_env_redact_test.go"},
	{"TestRedactSecret", "up_env_redact_test.go"},
	{"TestMaskKey", "up_env_redact_test.go"},
	{"TestTmpCleanFindArgs", "up_env_redact_test.go"},
	{"TestOrphanScanBash", "up_orphans_test.go"},
	{"TestScanOrphans", "up_orphans_scan_test.go"},
	{"TestKillSessionByMarker", "up_orphans_claim_test.go"},
	{"TestInUseClaim", "up_orphans_claim_test.go"},
	{"TestClassifyWorkspace", "up_workspace_test.go"},
	{"TestResolveStartWorkspace", "up_workspace_test.go"},
	{"TestResolveWorkspaceParent", "up_workspace_test.go"},
}

// TestUpFileLayout asserts the four new up test files plus the flow remainder
// match the up split plan: per-theme prefix placement, shared fixtures
// exactly once, no stray uncatalogued decls. Mirrors TestTestFileLayout with
// zero checker changes (merged=nil — all up decls live in the subject files).
func TestUpFileLayout(t *testing.T) {
	for _, v := range checkTestLayout(upSplitFiles, wantUpDecls, upSplitRules, nil) {
		t.Error(v)
	}
}

// TestTestFileLayout asserts the per-subject test files match the split plan.
func TestTestFileLayout(t *testing.T) {
	want := map[string]string{}
	for k, f := range initHelperDecls {
		want[k] = f
	}
	for k, f := range runInitFlowDecls {
		want[k] = f
	}
	for k, f := range skillRepoUseCaseDecls {
		want[k] = f
	}
	for k, f := range wantTestDecls {
		want[k] = f
	}
	for _, v := range checkTestLayout(testSplitFiles, want, testSplitRules, mergedTestDecls) {
		t.Error(v)
	}
}
