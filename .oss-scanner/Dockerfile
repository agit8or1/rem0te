# Build environment for Anthropic's OSS Scanner (https://github.com/anthropics/oss-scanner).
#
# The scanner builds this with the repository as the build context and network
# access, then runs everything afterwards with NO network. So every dependency
# the API, web app, launcher and Windows installer need — npm packages, Prisma
# engines, the Inter web font, Go modules, Rust crates — is fetched here.
#
# Nothing in this image is production configuration. The secrets written to
# /etc/reboot-remote/api.env are random values generated during the build, used
# only by the throwaway Postgres/Redis inside this image.
#
# After the build:
#   .oss-scanner/start-services.sh     # Postgres + Redis + the API on :3001
#   cd apps/api && node scripts/e2e-business-access.mjs   # business isolation proof
FROM node:22-bookworm

ENV DEBIAN_FRONTEND=noninteractive \
    NEXT_TELEMETRY_DISABLED=1 \
    PRISMA_HIDE_UPDATE_MESSAGE=1 \
    CHECKPOINT_DISABLE=1 \
    CI=1

# Postgres and Redis are what the API runs against in production. The webkit /
# GTK libraries are only for compiling the Tauri launcher (apps/launcher/src-tauri).
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl git python3 build-essential pkg-config openssl jq \
      postgresql postgresql-contrib redis-server \
      libwebkit2gtk-4.1-dev libgtk-3-dev libayatana-appindicator3-dev librsvg2-dev libssl-dev \
    && rm -rf /var/lib/apt/lists/*

# pnpm is pinned by `packageManager` in package.json; install exactly that.
RUN npm install -g pnpm@11.27.0 && pnpm --version

# Go toolchain for tools/windows-installer (go.mod asks for 1.26).
ARG GO_VERSION=1.26.0
RUN curl -fsSL "https://go.dev/dl/go${GO_VERSION}.linux-amd64.tar.gz" | tar -C /usr/local -xz
ENV PATH=/usr/local/go/bin:/root/.cargo/bin:$PATH \
    GOFLAGS=-mod=mod

# Rust toolchain for the Tauri launcher.
RUN curl -fsSL https://sh.rustup.rs | sh -s -- -y --profile minimal --default-toolchain stable

# scanner contract: the checkout lives inside the image, at /src
COPY . /src
WORKDIR /src

# --- JavaScript workspace (api, web, launcher frontend) ---------------------
# allowBuilds in pnpm-workspace.yaml permits the install scripts that argon2,
# prisma, esbuild and sharp need. Prisma downloads its query and schema engines
# here, so `prisma migrate` and `prisma generate` work offline afterwards.
RUN pnpm install --frozen-lockfile
RUN pnpm db:generate

# Same order as CI (.github/workflows/ci.yml). `pnpm build` runs the web
# prebuild (docs bundle) and next build, which fetches the Inter font now,
# while the network is still there.
RUN pnpm build
RUN pnpm --filter @reboot-remote/launcher build

# --- Windows installer (Go, cross-compiled; it only ever targets Windows) ----
RUN cd tools/windows-installer \
    && go mod download \
    && GOOS=windows GOARCH=amd64 go build -o /src/dist/windows-installer.exe . \
    && GOOS=windows GOARCH=amd64 go vet ./...

# --- Tauri launcher (Rust) ---------------------------------------------------
# Not compiled by CI either, so a failure here is reported, not fatal. Crates are
# fetched regardless so `cargo build --offline` works in the scan.
RUN cd apps/launcher/src-tauri \
    && cargo fetch \
    && (cargo build || echo "WARNING: launcher (src-tauri) did not compile")

# --- A local database the API and the e2e suites can run against offline ----
# Random, image-local secrets. Never reuse these anywhere.
RUN mkdir -p /etc/reboot-remote /var/lib/reboot-remote \
    && { \
      echo "NODE_ENV=production"; \
      echo "PORT=3001"; \
      echo "DATABASE_URL=postgresql://reboot:$(openssl rand -hex 16)@127.0.0.1:5432/reboot_remote"; \
      echo "REDIS_URL=redis://127.0.0.1:6379"; \
      echo "JWT_SECRET=$(openssl rand -hex 32)"; \
      echo "LAUNCHER_TOKEN_SECRET=$(openssl rand -hex 32)"; \
      echo "ENCRYPTION_KEY=$(openssl rand -hex 32)"; \
      echo "FRONTEND_URL=http://127.0.0.1:3000"; \
      echo "PUBLIC_API_URL=http://127.0.0.1:3001"; \
      echo "COOKIE_SECURE=false"; \
      echo "VERSION_FILE=/src/version.json"; \
      echo "PROJECT_ROOT=/src"; \
      echo "SEED_ADMIN_EMAIL=admin@example.com"; \
      echo "SEED_ADMIN_PASSWORD=$(openssl rand -hex 16)"; \
      echo "THROTTLE_LIMIT=100000"; \
    } > /etc/reboot-remote/api.env \
    && chmod 600 /etc/reboot-remote/api.env \
    && cp /etc/reboot-remote/api.env /src/apps/api/.env

RUN chmod +x /src/.oss-scanner/start-services.sh \
    && /src/.oss-scanner/start-services.sh --migrate-only

# Cheap checks, as CI runs them. Report failures; never fail the image on them.
RUN (node scripts/check-versions.mjs || echo "WARNING: check-versions failed") \
    && (node scripts/check-security-invariants.mjs || echo "WARNING: security invariants failed") \
    && (pnpm typecheck || echo "WARNING: typecheck failed")
