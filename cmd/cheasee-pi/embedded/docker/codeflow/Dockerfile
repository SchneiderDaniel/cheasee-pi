# CodeFlow local UI — serves the browser-based codebase visualizer against the
# mounted repository. See server.py for the API-shim contract.
FROM python:3.13-alpine

COPY server.py /opt/codeflow/server.py
COPY config.json /opt/codeflow/config.json

# Fail the build loudly if server.py is corrupt. A SyntaxError here would
# otherwise build fine and crash the container silently at startup.
RUN python3 -m py_compile /opt/codeflow/server.py

RUN apk add --no-cache git && \
    git clone --depth 1 https://github.com/braedonsaunders/codeflow /opt/codeflow-ui

ENV REPO_ROOT=/repo \
    UI_DIR=/opt/codeflow-ui

EXPOSE 8470

CMD ["python", "/opt/codeflow/server.py"]
