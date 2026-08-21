# Builder runtime for Mosaic Sandbox.
#
# Mosaic converts a public registry image into an "environment" (POST /v1/environments)
# and boots sandboxes from it in well under a second. Unlike sandbox-derived snapshots,
# an environment has no origin sandbox, so nothing can strand its backing file.
# See runtime/README.md for the measurements behind that choice.
#
# Mosaic constraints this image is written against:
#   - linux/amd64 only.
#   - /bin/sh must exist (distroless and scratch are refused at build time).
#   - The image's ENV is preserved; its WORKINGDIR is not. Commands start in /workspace.
#   - The guest's exec entrypoint runs as root, so privileged setup happens at boot and
#     project work is dropped to the unprivileged `builder` user by builder-run.
#
# Build and publish:
#   docker buildx build --platform linux/amd64 -t <registry>/divij-builder-runtime:<tag> --push runtime/
#   node scripts/mosaic-build-environment.mjs --image <registry>/divij-builder-runtime:<tag>

FROM node:22-bookworm-slim

ARG PLAYWRIGHT_VERSION=1.62.1
ARG PNPM_VERSION=11.22.0

# RUNTIME_VERSION is intentionally NOT declared here. Referencing it this high would put
# it in an early ENV layer, and bumping the version would then invalidate every layer
# below it -- including the ~2 GB Chromium install, forcing a full re-push for a one-line
# change. It is declared immediately before the only layer that needs it instead.
ENV DEBIAN_FRONTEND=noninteractive \
    PLAYWRIGHT_BROWSERS_PATH=/opt/playwright-browsers \
    PNPM_HOME=/opt/pnpm \
    NPM_CONFIG_UPDATE_NOTIFIER=false \
    NPM_CONFIG_FUND=false \
    NPM_CONFIG_AUDIT=false \
    BUILDER_WORKSPACE=/workspace/project \
    BUILDER_EGRESS_PORT=8123 \
    BUILDER_BROWSER_PORT=8124 \
    NEXT_TELEMETRY_DISABLED=1

# Toolchain. python3/make/g++ are required by node-gyp for native dependencies; iproute2
# provides `ip netns`, which is what actually confines project code. Deliberately no
# nftables or iptables: the Firecracker guest kernel has neither nf_tables nor xt_owner,
# so a firewall-based approach cannot work here (see runtime/README.md).
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl wget git unzip zip tar gzip xz-utils \
      ripgrep jq procps psmisc lsof \
      python3 make g++ pkg-config \
      iproute2 iputils-ping \
      openssl tini \
    && rm -rf /var/lib/apt/lists/*

# Chromium plus the shared libraries it needs. Installing the browser as root into a
# world-readable PLAYWRIGHT_BROWSERS_PATH lets the unprivileged user launch it without
# every sandbox re-downloading ~150 MB.
RUN npm install -g playwright@${PLAYWRIGHT_VERSION} \
    && playwright install --with-deps chromium \
    && chmod -R a+rX ${PLAYWRIGHT_BROWSERS_PATH} \
    && rm -rf /root/.npm /var/lib/apt/lists/*

RUN corepack enable && corepack prepare pnpm@${PNPM_VERSION} --activate \
    && mkdir -p ${PNPM_HOME} && chmod 777 ${PNPM_HOME}

# uid 1001 runs project code; uid 1002 runs the egress proxy so nftables can tell them
# apart by `meta skuid`. Neither may escalate.
RUN groupadd --gid 1001 builder \
    && useradd --uid 1001 --gid 1001 --create-home --shell /bin/bash builder \
    && groupadd --gid 1002 egress \
    && useradd --uid 1002 --gid 1002 --create-home --shell /usr/sbin/nologin egress \
    && mkdir -p /workspace/project /etc/builder /var/log/builder /var/run/builder \
    && chown -R builder:builder /workspace /var/log/builder /var/run/builder \
    && chmod 755 /etc/builder

COPY --chmod=0755 bin/ /usr/local/bin/
COPY services/ /opt/builder/services/
COPY policy/egress-allow.default.json /etc/builder/egress-allow.json

# Directories need the execute bit to be traversable; a blanket COPY --chmod=0644 would
# apply 0644 to the directory too and make every service unreadable to the egress user.
RUN chmod 0755 /opt/builder /opt/builder/services \
    && chmod 0644 /opt/builder/services/* /etc/builder/egress-allow.json \
    && chown -R root:root /opt/builder \
    # ESM resolution walks up node_modules directories and ignores NODE_PATH, so the
    # helper cannot `import 'playwright'` without one it can find. Linking rather than
    # reinstalling keeps a single ~150 MB Chromium in the image.
    && ln -s /usr/local/lib/node_modules /opt/builder/node_modules

# The browser helper depends only on the globally installed playwright.
ENV NODE_PATH=/usr/local/lib/node_modules

# Declared here, at the last possible moment, so a version bump rebuilds only the cheap
# tail of the image rather than the Chromium layer above it.
ARG RUNTIME_VERSION=1.0.0
ENV BUILDER_RUNTIME_VERSION=${RUNTIME_VERSION}

# Mosaic's `exec` endpoint inherits the image ENV but its durable process API does not,
# so a dev server or build started as a process comes up with a bare environment and
# loses NODE_PATH, PLAYWRIGHT_BROWSERS_PATH, and PNPM_HOME. Everything in the runtime
# sources this file instead of trusting what it inherited.
RUN printf '%s\n' \
      "NODE_PATH=/usr/local/lib/node_modules" \
      "PLAYWRIGHT_BROWSERS_PATH=${PLAYWRIGHT_BROWSERS_PATH}" \
      "PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1" \
      "PNPM_HOME=${PNPM_HOME}" \
      "BUILDER_RUNTIME_VERSION=${RUNTIME_VERSION}" \
      "BUILDER_WORKSPACE=/workspace/project" \
      "BUILDER_EGRESS_PORT=8123" \
      "BUILDER_BROWSER_PORT=8124" \
      "NEXT_TELEMETRY_DISABLED=1" \
      "PATH=/opt/pnpm:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin" \
    > /etc/builder/runtime.env \
    && chmod 0644 /etc/builder/runtime.env

RUN builder-selftest --build \
    && printf '%s\n' "${RUNTIME_VERSION}" > /etc/builder/runtime-version

LABEL org.opencontainers.image.title="divij-builder-runtime" \
      org.opencontainers.image.description="Node 22 + Chromium/Playwright sandbox runtime for the portable Mosaic builder" \
      org.opencontainers.image.version="${RUNTIME_VERSION}" \
      builder.playwright.version="${PLAYWRIGHT_VERSION}" \
      builder.pnpm.version="${PNPM_VERSION}"

# Mosaic drops WORKINGDIR and starts commands in /workspace; this only affects
# `docker run` locally, where the same selftest is the useful default.
WORKDIR /workspace
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["builder-selftest"]
