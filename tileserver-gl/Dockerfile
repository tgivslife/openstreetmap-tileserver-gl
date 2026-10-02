# Use Ubuntu 24.04 (Noble) as the base
FROM ubuntu:noble AS builder

ENV NODE_ENV="production"
SHELL ["/bin/bash", "-o", "pipefail", "-c"]

RUN export DEBIAN_FRONTEND=noninteractive && \
    apt-get update && \
    apt-get install -y --no-install-recommends --no-install-suggests \
      build-essential \
      python3-setuptools \
      ca-certificates \
      curl \
      gnupg \
      pkg-config \
      xvfb \
      libglfw3-dev \
      libuv1-dev \
      libcairo2-dev \
      libpango1.0-dev \
      libpng-dev \
      libjpeg-dev \
      libgif-dev \
      librsvg2-dev \
      libcurl4-openssl-dev \
      libicu-dev && \
    mkdir -p /etc/apt/keyrings && \
    curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key | gpg --dearmor -o /etc/apt/keyrings/nodesource.gpg && \
    echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_24.x nodistro main" | tee /etc/apt/sources.list.d/nodesource.list && \
    apt-get update && \
    apt-get install -y --no-install-recommends --no-install-suggests nodejs && \
    # Pinned to npm 12: the install below relies on its allowScripts gating and --strict-allow-scripts.
    npm i -g npm@12 && \
    apt-get -y remove curl gnupg && \
    apt-get -y --purge autoremove && \
    apt-get clean && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /usr/src/app

COPY package.json package-lock.json ./
# The esbuild entry for the viewer bundle must exist before `npm ci` runs the
# `prepare` lifecycle script, which builds public/resources/maplibre-gl.js from it.
COPY scripts ./scripts

RUN npm config set fetch-retries 5 && \
    npm config set fetch-retry-mintimeout 100000 && \
    npm config set fetch-retry-maxtimeout 600000 && \
    # Fail rather than skip when a dependency's install script is not covered by package.json#allowScripts: npm 12 only warns
    # and exits 0, which would ship an image without its native modules. After bumping canvas, sqlite3,
    # @maplibre/maplibre-gl-native or esbuild, run `npm install`, then re-pin with `npx npm@12 approve-scripts <pkg>`.
    npm ci --omit=dev --strict-allow-scripts && \
    # Build canvas from source: its prebuilt binary bundles libpng 1.6.37, which clashes with the system libpng
    # that maplibre-native links. Call node-gyp directly rather than steering prebuild-install through
    # npm_config_build_from_source, which npm warns is an unknown config and will reject in a future major.
    node_modules/.bin/node-gyp rebuild --directory=node_modules/canvas && \
    chown -R root:root /usr/src/app

# Drop packages that are only needed while installing/building. \
# The browser bundles were already copied into public/resources by the `prepare` lifecycle
# script above, and the gyp toolchain is never used again once the native addons are compiled.
RUN rm -rf \
      node_modules/maplibre-gl \
      node_modules/leaflet \
      node_modules/leaflet-hash \
      node_modules/@maplibre/maplibre-gl-inspect \
      node_modules/esbuild \
      node_modules/@esbuild \
      node_modules/node-gyp \
      node_modules/@octokit \
      node_modules/@acalcutt

# --- Final Stage ---
FROM ubuntu:noble AS final

SHELL ["/bin/bash", "-o", "pipefail", "-c"]

RUN export DEBIAN_FRONTEND=noninteractive && \
    groupadd -r node && \
    useradd -r -g node node && \
    apt-get update && \
    apt-get install -y --no-install-recommends --no-install-suggests \
      ca-certificates \
      curl \
      gnupg \
      tini \
      xvfb \
      libglfw3 \
      libuv1 \
      libicu74 \
      libcairo2 \
      libjpeg-turbo8 \
      libgif7 \
      libpng16-16t64 \
      libopengl0 \
      libcurl4 \
      librsvg2-2 \
      libpango-1.0-0 \
      libjemalloc2 && \
    mkdir -p /etc/apt/keyrings && \
    curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key | gpg --dearmor -o /etc/apt/keyrings/nodesource.gpg && \
    echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_24.x nodistro main" | tee /etc/apt/sources.list.d/nodesource.list && \
    apt-get update && \
    apt-get install -y --no-install-recommends --no-install-suggests nodejs && \
    # Create appropriate symlinks if needed
    ln -sf "$(find /usr -name "libjemalloc.so*" | head -n 1)" /usr/lib/libjemalloc.so && \
    apt-get -y remove curl gnupg && \
    apt-get -y --purge autoremove && \
    apt-get clean && \
    # The runtime only ever executes `node`. The nodejs package also ships addon headers, npm and corepack, none of which are used here.
    rm -rf \
      /usr/include/node \
      /usr/lib/node_modules \
      /usr/bin/npm /usr/bin/npx /usr/bin/corepack \
      /usr/share/doc /usr/share/man /usr/share/locale \
      /var/lib/apt/lists/*

RUN mkdir -p /home/node/.aws && \
    chown -R node:node /home/node

ENV \
    NODE_ENV="production" \
    HOME="/home/node" \
    LD_PRELOAD="/usr/lib/libjemalloc.so" \
    MALLOC_CONF="background_thread:true,metadata_thp:auto,dirty_decay_ms:5000,muzzy_decay_ms:5000"

COPY --from=builder /usr/src/app /usr/src/app
COPY . /usr/src/app

RUN mkdir -p /data && chown node:node /data
VOLUME /data
WORKDIR /data

EXPOSE 8080

USER node:node

# Provenance, set by scripts/build-images.sh from package.json and git; plain `docker build` leaves the defaults.
ARG VERSION=dev
ARG REVISION=unknown
ARG CREATED=unknown
LABEL org.opencontainers.image.title="tileserver-gl" \
      org.opencontainers.image.version="${VERSION}" \
      org.opencontainers.image.revision="${REVISION}" \
      org.opencontainers.image.created="${CREATED}"

# tini as PID 1 reaps the Xvfb the entrypoint backgrounds;
# without an init, node (PID 1) never reaps it and a crashed Xvfb lingers as a zombie.
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/src/app/docker-entrypoint.sh"]

# start-period gives slow first boots (large datasets) a grace window where a failing probe keeps the container "starting"
# rather than flipping it to "unhealthy"; a success during it marks healthy immediately.
HEALTHCHECK --start-period=60s --interval=30s --timeout=5s --retries=3 \
  CMD node /usr/src/app/src/healthcheck.js
