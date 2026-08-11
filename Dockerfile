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

COPY entrypoint.sh /entrypoint.sh
COPY --chown=node:node bootstrap.js /bootstrap.js
COPY --chown=node:node training-platform-chatbot.n8n.json \
    sub-workflow-sales.n8n.json \
    sub-workflow-manager.n8n.json \
    sub-workflow-instructor.n8n.json \
    sub-workflow-superadmin.n8n.json \
    /home/node/

ENTRYPOINT ["sh", "/entrypoint.sh"]
