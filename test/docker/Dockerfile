# Tier-1 install test: a clean Linux box for exercising scripts/install.sh's
# workspace logic (npm install + link, idempotency, file layout, error messages)
# fast and disposably. See docs/install-test-harness.md.
#
# This is NOT a macOS test. It deliberately runs the --skip-brew path, so it
# validates everything EXCEPT the Homebrew/macOS-specific steps. A pass here is
# necessary but not sufficient — the go/no-go is the tier-2 fresh-user Mac run.
#
# The image ships the *required* system deps (node from the base, plus uv and
# ffmpeg) so the script can reach the npm happy path. whisper-cpp is left out on
# purpose: it's optional, and its absence exercises the optional-missing branch.
#
# Build (from repo root):
#   docker build -f test/docker/Dockerfile -t anim-install-test .
# Run (mounts the live working tree read-only; nothing writes back to the host):
#   docker run --rm -v "$PWD":/src:ro anim-install-test
#
# node:24 matches the maintainer's local runtime; bump both together.
FROM node:24-bookworm-slim

# Required runtime deps the pipeline shells out to. Kept minimal.
#   ffmpeg  — video encode/decode (shot render, matte, speech clips)
#   ca-certificates + curl — TLS + the uv installer
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg ca-certificates curl \
 && rm -rf /var/lib/apt/lists/*

# uv runs the Python matte sidecar (numpy/pillow/onnxruntime/scipy) with no venv.
# Pinned installer, dropped onto PATH for all users.
RUN curl -LsSf https://astral.sh/uv/install.sh | env UV_INSTALL_DIR=/usr/local/bin sh

# Copy the tier-1 entrypoint. Source lives in the repo and is mounted at run time.
COPY test/docker/entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

# Non-root, matching a real user's account (catches root-only assumptions).
RUN useradd -ms /bin/bash tester
USER tester
WORKDIR /home/tester

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
