# CodeFlow local UI — serves the browser-based codebase visualizer against the
# mounted repository. See server.py for the API-shim contract.
FROM python:3.13-alpine

# Pin the served UI to the exact revision the export-control fixtures were
# captured from (test/fixtures/generate-ui-fixture.mjs). The browser bridge
# (`_BRIDGE_JS` in server.py) locates the export control by DOM contract only;
# a floating HEAD would let upstream relabel the menu while the fixture (and
# tests) go stale. bridge.test.mts asserts this ref matches the fixture's
# recorded revision, so the pin cannot drift from the fixtures silently.
ARG CODEFLOW_REF=b0e82d127fc4990f571ebc6da6c5d9af2591aaa1

COPY server.py /opt/codeflow/server.py
COPY config.json /opt/codeflow/config.json
COPY run-analysis.mjs /opt/codeflow/run-analysis.mjs

# Fail the build loudly if server.py is corrupt. A SyntaxError here would
# otherwise build fine and crash the container silently at startup.
RUN python3 -m py_compile /opt/codeflow/server.py

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
