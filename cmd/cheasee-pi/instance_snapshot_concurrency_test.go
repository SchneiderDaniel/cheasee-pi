package main

import (
	"context"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// ──────────────────────────────────────────────
// Snapshot publication serialisation (#2155 audit finding 1)
//
// Two `start`s finishing out of order interleave the read-probe-write cycle, so
// the slower one can publish a view it listed BEFORE the other recorded its
// workspace — shrinking the sidecar's list, dropping a live instance. The cycle
// is serialised host-wide; the last writer re-reads the registry.
// ──────────────────────────────────────────────

// waitClosed reports whether ch closes inside d.
func waitClosed(ch <-chan struct{}, d time.Duration) bool {
	timer := time.NewTimer(d)
	defer timer.Stop()
	select {
	case <-ch:
		return true
	case <-timer.C:
		return false
	}
}

// gatedInstanceRegistry holds its List until the test releases it, so a
// publication cycle can be frozen mid-flight; a second one then runs. It answers
// with the records captured at gate-build time — the stale view a refresh would
// have read before the peer recorded itself.
type gatedInstanceRegistry struct {
	inner   InstanceRegistry
	entered chan struct{}
	release chan struct{}
	stale   []InstanceRecord
	once    sync.Once
}

func (g *gatedInstanceRegistry) Record(rec InstanceRecord) error { return g.inner.Record(rec) }

func (g *gatedInstanceRegistry) Remove(key string) error { return g.inner.Remove(key) }

func (g *gatedInstanceRegistry) List() ([]InstanceRecord, error) {
	// A plain Once would serialise reentrant callers by itself, hiding the bug.
	g.once.Do(func() { close(g.entered) })
	<-g.release
	return g.stale, nil
}

// discoveryTwoRunningRecords builds ws1/ws2 records plus the `docker ps -a`
// answer that reports both containers running: only the registry listing then
// decides what the snapshot holds.
func discoveryTwoRunningRecords(t *testing.T) (InstanceRecord, InstanceRecord) {
	t.Helper()
	ws1 := discoveryRecord("alice-foo-00000000")
	ws1.Label = "alice-foo (ws1)"
	ws2 := discoveryRecord("alice-foo-11111111")
	ws2.Label = "alice-foo (ws2)"
	stubSnapshotStates(t, containerNameFromKey(ws1.Key)+"|running\n"+containerNameFromKey(ws2.Key)+"|running\n", nil)
	return ws1, ws2
}

// snapshotQueueWindow is how long the fresh refresh gets to overtake the stale
// one. It elapses only on the serialised path (the fresh cycle blocks on the lock
// by design), so the budget costs the suite 200ms — enough for a lock-less
// publisher to fail inside one scheduling quantum.
const snapshotQueueWindow = 200 * time.Millisecond

// TestDiscovery_snapshotConcurrentRefreshKeepsBothInstances forces the
// out-of-order finish that shrank the sidecar's list: ws1's cycle lists a
// registry holding just ws1, then stalls; ws2 records itself, publishing its
// complete view; ws1's stale cycle writes last.
//
// The publication lock keeps that window shut: the fresh cycle cannot enter
// during the stale one, so it lists AFTER the stale write, republishing both
// rows. Without the lock the fresh cycle publishes first, the stale listing
// overwrites it, leaving one row — this test then fails on the row count,
// deterministically.
func TestDiscovery_snapshotConcurrentRefreshKeepsBothInstances(t *testing.T) {
	ws1, ws2 := discoveryTwoRunningRecords(t)
	inner := discoverySnapshotRegistry(t, ws1)
	path := discoverySnapshotPath(t)

	gate := &gatedInstanceRegistry{
		inner:   inner,
		entered: make(chan struct{}),
		release: make(chan struct{}),
		stale:   []InstanceRecord{ws1},
	}
	staleRead := make(chan error, 1)
	go func() { staleRead <- writeInstanceSnapshot(context.Background(), gate, path) }()
	<-gate.entered

	// The peer starts NOW: it records itself, publishing its own complete view;
	// the first cycle still holds the stale listing.
	discoveryRequireNoErr(t, "Record", inner.Record(ws2))
	freshRead := make(chan error, 1)
	freshFinished := make(chan struct{})
	go func() {
		defer close(freshFinished)
		freshRead <- writeInstanceSnapshot(context.Background(), inner, path)
	}()

	// A serialised fresh cycle cannot finish here: it blocks on the lock the stale
	// cycle holds. A cycle that finishes inside the window published concurrently —
	// its stale write then lands last, dropping ws2.
	serialised := !waitClosed(freshFinished, snapshotQueueWindow)
	close(gate.release)

	discoveryRequireNoErr(t, "stale-listing publish", <-staleRead)
	discoveryRequireNoErr(t, "fresh-listing publish", <-freshRead)

	doc := readSnapshot(t, path)
	if !serialised {
		t.Fatalf("the fresh refresh published mid-cycle with a stale one in flight — the read-probe-write cycle must be serialised")
	}
	if len(doc) != 2 {
		t.Fatalf("snapshot = %v, want both instances — the last writer must re-read the registry", doc)
	}
	if doc[0]["key"] != ws1.Key || doc[1]["key"] != ws2.Key {
		t.Errorf("snapshot keys = %v, %v — want key order %s, %s", doc[0]["key"], doc[1]["key"], ws1.Key, ws2.Key)
	}
}

// overlapInstanceRegistry flags any moment in which two List calls are in flight
// at once — i.e. two publication cycles interleaving instead of queueing.
type overlapInstanceRegistry struct {
	inner    InstanceRegistry
	inFlight atomic.Int32
	overlaps atomic.Int32
	held     atomic.Bool
	entered  chan struct{}
	release  chan struct{}
}

func (r *overlapInstanceRegistry) Record(rec InstanceRecord) error { return r.inner.Record(rec) }

func (r *overlapInstanceRegistry) Remove(key string) error { return r.inner.Remove(key) }

func (r *overlapInstanceRegistry) List() ([]InstanceRecord, error) {
	if r.inFlight.Add(1) > 1 {
		r.overlaps.Add(1)
	}
	defer r.inFlight.Add(-1)
	if r.held.CompareAndSwap(false, true) {
		close(r.entered)
		<-r.release
	}
	return r.inner.List()
}

// discoveryRequireNoOverlapAndRelease asserts that no second cycle reached the
// registry while the first still holds it, then lets the first finish.
func discoveryRequireNoOverlapAndRelease(t *testing.T, reg *overlapInstanceRegistry) {
	t.Helper()
	// The waiting cycle had 50ms to enter the registry: serialised means it never
	// could. (A closed channel here means the test bug of double release.)
	if waitClosed(reg.release, 50*time.Millisecond) {
		t.Fatal("test bug: release channel already closed")
	}
	if got := reg.inFlight.Load(); got != 1 {
		t.Fatalf("in-flight publication cycles = %d, want exactly 1 — cycles must queue, not interleave", got)
	}
	close(reg.release)
}

// TestDiscovery_snapshotPublicationIsSerialized pins the mechanism, not just the
// symptom: a second refresh cannot enter the registry while a first one holds
// the publication lock.
func TestDiscovery_snapshotPublicationIsSerialized(t *testing.T) {
	ws1, _ := discoveryTwoRunningRecords(t)
	inner := discoverySnapshotRegistry(t, ws1)
	path := discoverySnapshotPath(t)

	reg := &overlapInstanceRegistry{
		inner:   inner,
		entered: make(chan struct{}),
		release: make(chan struct{}),
	}
	first := make(chan error, 1)
	go func() { first <- writeInstanceSnapshot(context.Background(), reg, path) }()
	<-reg.entered

	second := make(chan error, 1)
	go func() { second <- writeInstanceSnapshot(context.Background(), reg, path) }()
	discoveryRequireNoOverlapAndRelease(t, reg)

	discoveryRequireNoErr(t, "first publish", <-first)
	discoveryRequireNoErr(t, "second publish", <-second)
	if got := reg.overlaps.Load(); got != 0 {
		t.Errorf("overlapping publication cycles = %d, want 0 — the read-probe-write cycle must run under one lock", got)
	}
}
