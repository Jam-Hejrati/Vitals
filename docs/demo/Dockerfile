# VHS (https://github.com/charmbracelet/vhs) with Node.js, to record the README demo.
# See record.sh.
FROM node:22.20.0-bookworm-slim AS node
FROM ghcr.io/charmbracelet/vhs:v0.10.0
COPY --from=node /usr/local/bin/node /usr/local/bin/node
COPY --from=node /usr/local/lib/node_modules /usr/local/lib/node_modules
RUN ln -s ../lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm \
  && ln -s ../lib/node_modules/npm/bin/npx-cli.js /usr/local/bin/npx
