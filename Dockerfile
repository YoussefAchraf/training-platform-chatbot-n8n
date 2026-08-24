# Bakes this repo's actual chatbot logic/config into the upstream n8n
# image, so it's a real, self-contained, pullable artifact on GHCR -
# instead of the docker-compose-only pattern of bind-mounting these same
# files into a stock n8nio/n8n container at runtime. Paths below are
# exactly where docker-compose.yml already bind-mounts each file today
# (entrypoint.sh/bootstrap.js at the image root, the workflow exports
# under /home/node/) - entrypoint.sh's own "node /bootstrap.js" and
# bootstrap.js's own hardcoded "/home/node/*.n8n.json" WORKFLOW_FILES
# paths are unchanged, so this is a straight translation, not new logic.
FROM n8nio/n8n:latest

# Real, unpatched-upstream CRITICAL vulnerability, confirmed live against
# this exact base image (Trivy: 3 CRITICAL findings - CVE-2026-47686,
# CVE-2026-47698, and a third - all in vm2@3.11.5, all sandbox-escape-to-
# RCE class, all fixed upstream in vm2 3.11.6, disclosed 2026-08-17). Not
# something this repo's own package.json controls: n8n-nodes-base (n8n's
# own built-in nodes package) still depends on the original community
# `vm2` directly - n8n's own code has already moved to their maintained
# fork, @n8n/vm2, but this one dependency hasn't been migrated - and as of
# this image's build, upstream hasn't bumped it either. Confirmed exactly
# ONE physical copy exists in the image (pnpm's content-addressable store -
# every consumer resolves through this same path), so patching it here
# fixes it for anything in the image that uses vm2, not just one caller.
#
# Verified directly against the real image before writing this (`docker
# run --entrypoint sh n8nio/n8n:latest`): exact path confirmed, root-owned
# (not writable by the image's own default `node` user, hence the USER
# root/USER node bracketing below), and the replacement tarball's shasum
# is checked against npm's own published registry metadata before
# extracting - never blindly trusted. Swapping the whole package for
# upstream's real 3.11.6 release (not a hand-patched diff) since it's a
# minimal, non-breaking patch version bump - same source, not a fork.
#
# Degrades gracefully, does not hard-fail the build, if upstream n8n has
# already bumped past 3.11.5 by the time this runs (path just won't exist)
# - safe to delete this whole block once that's confirmed true, rather
# than something that needs removing urgently.
USER root
RUN VM2_DIR=/usr/local/lib/node_modules/n8n/node_modules/.pnpm/vm2@3.11.5/node_modules/vm2; \
    if [ -d "$VM2_DIR" ]; then \
      echo "[vm2 patch] vulnerable vm2@3.11.5 found, patching to 3.11.6..." && \
      wget -qO /tmp/vm2-3.11.6.tgz https://registry.npmjs.org/vm2/-/vm2-3.11.6.tgz && \
      echo "044ddbbd68c0157bc07b2e2fca20f38d3d673be7  /tmp/vm2-3.11.6.tgz" | sha1sum -c - && \
      rm -rf "$VM2_DIR"/* && \
      tar -xzf /tmp/vm2-3.11.6.tgz -C "$VM2_DIR" --strip-components=1 && \
      rm /tmp/vm2-3.11.6.tgz && \
      echo "[vm2 patch] done."; \
    else \
      echo "[vm2 patch] vm2@3.11.5 not found at the expected path - upstream likely fixed this already, skipping (safe to remove this Dockerfile block)."; \
    fi
USER node

COPY entrypoint.sh /entrypoint.sh
COPY --chown=node:node bootstrap.js /bootstrap.js
COPY --chown=node:node training-platform-chatbot.n8n.json \
    sub-workflow-sales.n8n.json \
    sub-workflow-manager.n8n.json \
    sub-workflow-instructor.n8n.json \
    sub-workflow-superadmin.n8n.json \
    /home/node/

ENTRYPOINT ["sh", "/entrypoint.sh"]
