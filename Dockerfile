FROM n8nio/n8n:latest

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
    sub-workflow-developer.n8n.json \
    /home/node/

ENTRYPOINT ["sh", "/entrypoint.sh"]
