package main

import (
	"go/ast"
	"go/parser"
	"go/token"
	"os"
	"strings"
	"testing"
)

// initSplitFiles are the files produced by the init.go responsibility split.
// Any new file added to this set must also be added to the nbnc check below.
var initSplitFiles = []string{
	"init.go",
	"init_auth.go",
	"init_prompt.go",
	"init_scaffold.go",
	"init_submodule.go",
}

// wantInitDecls is the full inventory of top-level declarations in the five
// init*.go files, mapped to their target file. It mirrors the split plan: a
// decl placed in the wrong file (or renamed) fails the test.
var wantInitDecls = map[string]string{
	"const:nextStepHint": "init.go",
	"var:initAPIKey,initNoDockerCheck,initWorkdir,initSourceRepo,initNoGitHub,initClientID,initProvider,initSkipFork,initForkURL,initNoInput,initSubmoduleURLs,initSkipSubmodules": "init.go",
	"type:SourceForkMode":                              "init.go",
	"const:ModePromptFork,ModeUseForkURL,ModeSkipFork": "init.go",
	"type:SourceForkInput":                             "init.go",
	"type:InitPorts":                                   "init.go",
	"type:InitDeps":                                    "init.go",
	"func:Validate":                                    "init.go",
	"var:initCmd":                                      "init.go",
	"func:init":                                        "init.go",
	"func:runInitE":                                    "init.go",
	"func:runInit":                                     "init.go",
	"func:runInitProbe":                                "init.go",

	"func:runInitAuth":    "init_auth.go",
	"func:runInitAPIKeys": "init_auth.go",
	"func:runInitLegacy":  "init_auth.go",
	"func:promptAPIKey":   "init_auth.go",

	"func:runInitSubmodule":        "init_submodule.go",
	"func:removeSubmoduleDirs":     "init_submodule.go",
	"func:removeSubmoduleSettings": "init_submodule.go",
	"func:runInitCloneSubmodule":   "init_submodule.go",
	"func:parseSubmoduleURLs":      "init_submodule.go",
	"func:promptSubmoduleURLs":     "init_submodule.go",

	"func:runInitDockerCheck": "init_scaffold.go",
	"func:runInitExtract":     "init_scaffold.go",
	"func:runInitEnv":         "init_scaffold.go",
	"func:runInitGitInit":     "init_scaffold.go",
	"func:runInitScaffold":    "init_scaffold.go",

	"func:promptConfirm":       "init_prompt.go",
	"func:promptGitIdentity":   "init_prompt.go",
	"func:promptInput":         "init_prompt.go",
	"func:runInitPromptSource": "init_prompt.go",
}

// declKey returns a stable identifier for a top-level declaration.
func declKey(d ast.Decl) string {
	switch dd := d.(type) {
	case *ast.FuncDecl:
		return "func:" + dd.Name.Name
	case *ast.GenDecl:
		if dd.Tok == token.IMPORT {
			return ""
		}
		var names []string
		for _, s := range dd.Specs {
			switch sp := s.(type) {
			case *ast.TypeSpec:
				names = append(names, sp.Name.Name)
			case *ast.ValueSpec:
				for _, n := range sp.Names {
					names = append(names, n.Name)
				}
			}
		}
		return dd.Tok.String() + ":" + strings.Join(names, ",")
	}
	return ""
}

// topLevelDecls parses one file and returns its top-level decl keys.
func topLevelDecls(t *testing.T, file string) []string {
	t.Helper()
	fset := token.NewFileSet()
	f, err := parser.ParseFile(fset, file, nil, 0)
	if err != nil {
		t.Fatalf("parse %s: %v", file, err)
	}
	var keys []string
	for _, d := range f.Decls {
		if k := declKey(d); k != "" {
			keys = append(keys, k)
		}
	}
	return keys
}

// TestInitSplitDeclPlacement asserts every inventory decl sits in its target
// file and that the five init*.go files contain nothing outside the inventory.
func TestInitSplitDeclPlacement(t *testing.T) {
	found := map[string]string{} // decl key -> file it was found in
	for _, file := range initSplitFiles {
		for _, key := range topLevelDecls(t, file) {
			if prev, ok := found[key]; ok {
				t.Errorf("decl %q found in both %s and %s", key, prev, file)
				continue
			}
			found[key] = file
		}
	}

	if len(found) != len(wantInitDecls) {
		t.Errorf("found %d top-level decls in init*.go files, inventory has %d", len(found), len(wantInitDecls))
	}

	for key, file := range found {
		wantFile, ok := wantInitDecls[key]
		if !ok {
			t.Errorf("decl %q in %s is not in the split inventory — move it to the planned file", key, file)
			continue
		}
		if file != wantFile {
			t.Errorf("decl %q is in %s, expected %s", key, file, wantFile)
		}
	}
	for key, wantFile := range wantInitDecls {
		if file, ok := found[key]; !ok {
			t.Errorf("inventory decl %q missing from %s", key, wantFile)
		} else if file != wantFile {
			t.Errorf("inventory decl %q in %s, expected %s", key, file, wantFile)
		}
	}
}

// TestInitSplitNoExtraInit asserts func init() lives only in init.go, so flag
// registration keeps its current order (init.go sorts before init_*.go).
func TestInitSplitNoExtraInit(t *testing.T) {
	for _, file := range initSplitFiles {
		for _, key := range topLevelDecls(t, file) {
			if key != "func:init" {
				continue
			}
			if file != "init.go" {
				t.Errorf("func init() found in %s; it must stay in init.go", file)
			}
		}
	}
}

// TestInitSplitFileSize asserts each split file stays under the 500 nbnc
// ceiling (non-blank, non-comment-first lines, matching the audit measure).
func TestInitSplitFileSize(t *testing.T) {
	const ceiling = 500
	for _, file := range initSplitFiles {
		data, err := os.ReadFile(file)
		if err != nil {
			t.Fatalf("read %s: %v", file, err)
		}
		nbnc := 0
		for _, line := range strings.Split(string(data), "\n") {
			trimmed := strings.TrimSpace(line)
			if trimmed != "" && !strings.HasPrefix(trimmed, "//") {
				nbnc++
			}
		}
		if nbnc >= ceiling {
			t.Errorf("%s has %d non-blank/non-comment lines, ceiling is %d", file, nbnc, ceiling)
		}
	}
}
