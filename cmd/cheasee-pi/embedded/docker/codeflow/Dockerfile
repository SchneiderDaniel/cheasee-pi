# CodeFlow local UI — serves the browser-based codebase visualizer against the
# mounted repository. See server.py for the API-shim contract.
# Digest-pinned base image (issue #2053): an upstream retag cannot invalidate
# the layers below. Rotation cadence + procedure: docs/security.md.
FROM python:3.13-alpine@sha256:2d9aefe2fef018a7eb2c13064c89c71929800fd2e5dccdbf52ea5da5bb8d929a

# Pin the served UI to the exact revision the export-control fixtures were
# captured from (test/fixtures/generate-ui-fixture.mjs). The browser bridge
# (`_BRIDGE_JS` in server.py) locates the export control by DOM contract only;
# a floating HEAD would let upstream relabel the menu while the fixture (and
# tests) go stale. bridge.test.mts asserts this ref matches the fixture's
# recorded revision, so the pin cannot drift from the fixtures silently.
ARG CODEFLOW_REF=b0e82d127fc4990f571ebc6da6c5d9af2591aaa1

# The shim is server.py plus the sibling modules it imports (the browser bridge
# asset, config, the report store, the headless run state machine, the
# committed-tree identity and the served-page rewrites); all of them must land in
# the same directory.
COPY server.py bridge_js.py config.py report_store.py analysis_run.py repo_identity.py ui_rewrites.py handler_api.py /opt/codeflow/
COPY config.json /opt/codeflow/config.json
COPY run-analysis.mjs /opt/codeflow/run-analysis.mjs
# False-positive policy, shared by the headless runner and the served page
# (server.py requires it from this same directory).
COPY fp-filter.js /opt/codeflow/fp-filter.js

# Fail the build loudly if any shim module is corrupt. A SyntaxError here would
# otherwise build fine and crash the container silently at startup.
RUN python3 -m py_compile /opt/codeflow/*.py

# nodejs: the on-demand headless analyzer (run-analysis.mjs). No npm packages —
# the runner imports only node: builtins and the pinned UI checkout's own code.
RUN apk add --no-cache git nodejs && \
    git init /opt/codeflow-ui && \
    cd /opt/codeflow-ui && \
    git remote add origin https://github.com/braedonsaunders/codeflow && \
    git fetch --depth 1 origin "$CODEFLOW_REF" && \
    git checkout --detach FETCH_HEAD && \
    git remote remove origin

ENV REPO_ROOT=/repo \
    UI_DIR=/opt/codeflow-ui

EXPOSE 8470

CMD ["python", "/opt/codeflow/server.py"]
