# syntax=docker/dockerfile:1.7

FROM node:24.12.0-bookworm-slim@sha256:7326fb2dbdce998edd72140946851be64ef4a643e8715e138ca467e8e9d92c99 AS build

WORKDIR /source
RUN corepack enable
COPY . .
RUN pnpm install --frozen-lockfile \
  && pnpm --filter @browshare/remote-tab-standalone... build \
  && pnpm --filter @browshare/remote-tab-signaling... build \
  && pnpm --filter @browshare/remote-tab-standalone deploy --legacy --prod /out/standalone \
  && pnpm --filter @browshare/remote-tab-signaling deploy --legacy --prod /out/signaling

FROM node:24.12.0-bookworm-slim@sha256:7326fb2dbdce998edd72140946851be64ef4a643e8715e138ca467e8e9d92c99 AS runtime-base

ENV NODE_ENV=production
WORKDIR /app
RUN apt-get update \
  && apt-get upgrade --yes --no-install-recommends \
  && apt-get install --yes --no-install-recommends tini \
  && rm -rf /var/lib/apt/lists/* \
    /usr/local/lib/node_modules/corepack \
    /usr/local/lib/node_modules/npm \
    /opt/yarn-v1.22.22 \
  && rm -f /usr/local/bin/corepack /usr/local/bin/npm /usr/local/bin/npx \
    /usr/local/bin/pnpm /usr/local/bin/pnpx /usr/local/bin/yarn /usr/local/bin/yarnpkg

FROM runtime-base AS signaling

# pnpm deploy preserves source modes, including package.json from a restrictive checkout.
COPY --from=build --chown=node:node /out/signaling/ /app/
USER node
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "dist/cli.mjs"]

FROM runtime-base AS standalone

COPY --from=build --chown=node:node /out/standalone/ /app/
USER node
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "dist/cli.mjs"]

FROM standalone AS chrome-node

ARG GOOGLE_CHROME_VERSION=152.0.7977.75-1
ARG GOOGLE_CHROME_DEB_URL=https://dl.google.com/linux/chrome/deb/pool/main/g/google-chrome-stable/google-chrome-stable_152.0.7977.75-1_amd64.deb
ARG GOOGLE_CHROME_DEB_SHA256=a0b7a64f768ffc0ff5ccc9260ad9ebb53fd16f7a131e2e36994da58b82d913df
ENV NODE_ENV=production
USER root
RUN test "$(dpkg --print-architecture)" = amd64 \
  && apt-get update \
  && apt-get install --yes --no-install-recommends ca-certificates curl fontconfig fonts-liberation fonts-noto-cjk gosu unzip \
  && curl --fail --show-error --silent --location "$GOOGLE_CHROME_DEB_URL" --output /tmp/google-chrome.deb \
  && echo "$GOOGLE_CHROME_DEB_SHA256  /tmp/google-chrome.deb" | sha256sum --check --strict \
  && apt-get install --yes --no-install-recommends /tmp/google-chrome.deb \
  && test "$(dpkg-query -W -f='${Version}' google-chrome-stable)" = "$GOOGLE_CHROME_VERSION" \
  && rm -f /tmp/google-chrome.deb \
  && rm -rf /var/lib/apt/lists/*
COPY --chmod=0644 deploy/docker/50-browshare-fonts.conf /etc/fonts/conf.d/50-browshare-fonts.conf
COPY deploy/docker/write-managed-policy.mjs /usr/local/lib/browshare/write-managed-policy.mjs
COPY --chmod=0644 deploy/docker/configure-chrome-fonts.mjs /usr/local/lib/browshare/configure-chrome-fonts.mjs
COPY deploy/docker/chrome-node-entrypoint.sh /usr/local/bin/browshare-chrome-node
RUN chmod 0755 /usr/local/bin/browshare-chrome-node \
  && mkdir -p /var/lib/browshare/chrome-profile /var/lib/browshare/remote-tab /var/log/browshare \
  && chown -R node:node /var/lib/browshare /var/log/browshare
# Chrome must decode non-ASCII upload paths using a UTF-8 locale.
ENV LANG=C.UTF-8
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/browshare-chrome-node"]
