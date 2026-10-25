package main

import (
	"strings"
	"testing"
)

// BuildKit cache mounts (issue #2053): a re-run of a download-heavy layer reads
// the archives from the builder cache instead of re-fetching them. The checks
// below are per RUN body and count-agnostic, so splitting or adding an
// apt/npm/pip layer cannot slip past them.

const (
	aptCacheMount = "--mount=type=cache,target=/var/cache/apt,sharing=locked"
	aptLibsMount  = "--mount=type=cache,target=/var/lib/apt,sharing=locked"
	npmMountFlag  = "--mount=type=cache,target=/root/.npm"
	pipMountFlag  = "--mount=type=cache,target=/root/.cache/pip"
)

func hasFlag(flags []string, want string) bool {
	for _, f := range flags {
		if f == want {
			return true
		}
	}
	return false
}

func TestDockerfiles_AptRunsMountAptCaches(t *testing.T) {
	covered := 0
	for _, df := range dockerfiles(t) {
		for i, r := range runInstructions(df.content) {
			if !strings.Contains(r.body, "apt-get") {
				continue
			}
			covered++
			// apt needs exclusive access, hence sharing=locked on both targets.
			for _, want := range []string{aptCacheMount, aptLibsMount} {
				if !hasFlag(r.flags, want) {
					t.Errorf("%s RUN #%d runs apt-get without %s (a re-run re-downloads the archive list)", df.name, i+1, want)
				}
			}
		}
	}
	if covered == 0 {
		t.Fatal("no apt-get RUN found — the mount check would be vacuous")
	}
}

func TestDockerfiles_AptInstallFollowsUpdate(t *testing.T) {
	// With /var/lib/apt mounted, a cold builder starts with no package indexes:
	// the RUN that installs must refresh them itself, or apt-get install cannot
	// resolve a single package. Ordering matters — an update after the install
	// is dead weight.
	covered := 0
	for _, df := range dockerfiles(t) {
		for i, r := range runInstructions(df.content) {
			install := strings.Index(r.body, "apt-get install")
			if install < 0 {
				continue
			}
			covered++
			update := strings.Index(r.body, "apt-get update")
			if update < 0 {
				t.Errorf("%s RUN #%d installs packages without 'apt-get update' in the same RUN (a cold builder has an empty /var/lib/apt mount)", df.name, i+1)
			} else if update > install {
				t.Errorf("%s RUN #%d updates the apt indexes after 'apt-get install'", df.name, i+1)
			}
		}
	}
	if covered == 0 {
		t.Fatal("no apt-get install RUN found — the update check would be vacuous")
	}
}

func TestDockerfiles_NpmRunsMountNpmCache(t *testing.T) {
	covered := 0
	for _, df := range dockerfiles(t) {
		for i, r := range runInstructions(df.content) {
			if !strings.Contains(r.body, "npm install") && !strings.Contains(r.body, "npm ci") {
				continue
			}
			covered++
			if !hasFlag(r.flags, npmMountFlag) {
				t.Errorf("%s RUN #%d runs npm without %s", df.name, i+1, npmMountFlag)
			}
		}
	}
	if covered == 0 {
		t.Fatal("no npm RUN found — the mount check would be vacuous")
	}
}

func TestDockerfiles_PipRunsMountPipCache(t *testing.T) {
	covered := 0
	for _, df := range dockerfiles(t) {
		for i, r := range runInstructions(df.content) {
			if !strings.Contains(r.body, "pip install") {
				continue
			}
			covered++
			if !hasFlag(r.flags, pipMountFlag) {
				t.Errorf("%s RUN #%d runs pip install without %s", df.name, i+1, pipMountFlag)
			}
			// --no-cache-dir makes the mount dead weight: nothing is written to
			// the cache the next build would read.
			if strings.Contains(r.body, "--no-cache-dir") {
				t.Errorf("%s RUN #%d installs with --no-cache-dir, defeating %s", df.name, i+1, pipMountFlag)
			}
		}
	}
	if covered == 0 {
		t.Fatal("no pip RUN found — the mount check would be vacuous")
	}
}

func TestDockerfiles_NoNpmCacheClean(t *testing.T) {
	// A mounted cache never enters the layer, so the cleanup is both pointless
	// and destructive: it empties the mount for the next build.
	for _, df := range dockerfiles(t) {
		for i, r := range runInstructions(df.content) {
			if strings.Contains(r.body, "npm cache clean") {
				t.Errorf("%s RUN #%d runs 'npm cache clean' — it wipes the mounted npm cache; drop it", df.name, i+1)
			}
		}
	}
}

func TestDockerfiles_NoRootCacheWipe(t *testing.T) {
	// `rm -rf /root/.cache/*` under the pip mount deletes the cache it just
	// populated; only /tmp scratch may be cleaned.
	for _, df := range dockerfiles(t) {
		if strings.Contains(df.content, "rm -rf /root/.cache") {
			t.Errorf("%s must not wipe /root/.cache (mounted) — restrict cleanup to /tmp/*", df.name)
		}
	}
}

func TestDockerfiles_AptListsNotDeletedUnderMount(t *testing.T) {
	// /var/lib/apt is mounted: removing its lists directory throws away the
	// cached package lists, which is the download the mount exists to avoid.
	// RUN bodies only — comments legitimately explain why it is gone.
	for _, df := range dockerfiles(t) {
		for i, r := range runInstructions(df.content) {
			if strings.Contains(r.body, "rm -rf /var/lib/apt/lists") {
				t.Errorf("%s RUN #%d deletes /var/lib/apt/lists under a /var/lib/apt cache mount", df.name, i+1)
			}
		}
	}
}

func TestDockerfiles_MountedTargetsSurviveInRunCleanup(t *testing.T) {
	for _, df := range dockerfiles(t) {
		for i, r := range runInstructions(df.content) {
			for _, f := range r.flags {
				target, ok := strings.CutPrefix(f, "--mount=type=cache,target=")
				if !ok {
					continue
				}
				target, _, _ = strings.Cut(target, ",")
				for _, doomed := range []string{"rm -rf " + target, target + "/"} {
					if strings.Contains(r.body, doomed) {
						t.Errorf("%s RUN #%d removes %q inside the RUN that mounts it as a cache", df.name, i+1, doomed)
					}
				}
			}
		}
	}
}

func TestDockerfiles_AptRunsDisableDockerCleanHook(t *testing.T) {
	// The Debian base images ship /etc/apt/apt.conf.d/docker-clean. Its
	// DPkg::Post-Invoke deletes /var/cache/apt/archives/*.deb after dpkg runs,
	// which empties the archive cache the /var/cache/apt mount exists to reuse —
	// so a mount alone is not enough. Removal must precede the first apt-get of
	// the same RUN, otherwise that RUN still fires the hook.
	const hook = "rm -f /etc/apt/apt.conf.d/docker-clean"
	covered := 0
	for _, df := range dockerfiles(t) {
		for i, r := range runInstructions(df.content) {
			at := strings.Index(r.body, "apt-get")
			if at < 0 {
				continue
			}
			covered++
			hookAt := strings.Index(r.body, hook)
			if hookAt < 0 {
				t.Errorf("%s RUN #%d runs apt-get without removing the docker-clean hook (it deletes the mounted .deb archives)", df.name, i+1)
			} else if hookAt > at {
				t.Errorf("%s RUN #%d removes the docker-clean hook after apt-get — the hook still runs", df.name, i+1)
			}
		}
	}
	if covered == 0 {
		t.Fatal("no apt-get RUN found — the docker-clean check would be vacuous")
	}
}

func TestDockerfiles_TmpCleanupRetained(t *testing.T) {
	// The mounts only cover the package caches; the /tmp scratch still has to
	// be cleaned inside the layer that writes it.
	withInstalls := 0
	for _, df := range dockerfiles(t) {
		installs := 0
		for i, r := range runInstructions(df.content) {
			if !strings.Contains(r.body, "npm install -g") {
				continue
			}
			installs++
			if !strings.Contains(r.body, "rm -rf /tmp/*") {
				t.Errorf("%s RUN #%d: an 'npm install -g' RUN must still clean /tmp scratch", df.name, i+1)
			}
		}
		if installs > 0 {
			withInstalls++
		}
	}
	if withInstalls < 2 {
		t.Fatalf("expected the agent and ui Dockerfiles to install pi globally, got %d files", withInstalls)
	}
}
