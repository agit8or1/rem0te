-- 0.87.0 Compass: the navigation redesign — each person's own menu
-- preferences, favourites and recent items (invariant §96).
--
-- Presentation only. Standard and Advanced reach the same pages; a pinned
-- group or a collapsed sidebar changes what is drawn, never what is allowed.
-- A favourite or a recent item stores a kind and a reference (a record id or
-- a console path), never a name or a URL: the API resolves every one through
-- the record's own visibility rule on each read (navigation.service.ts), so a
-- computer someone can no longer see drops out of their list by itself.
--
-- The closed lists are apps/api/src/navigation/model.ts's, word for word and
-- in order (§96 compares them): MODES, DENSITIES, GROUP_IDS, LISTS, KINDS.
-- The caps (50 favourites, 15 recent) are the service's, inside one
-- transaction; the CHECKs hold the shapes.

-- CreateTable
CREATE TABLE "UserNavPreference" (
    "userId" TEXT NOT NULL,
    "mode" TEXT NOT NULL DEFAULT 'standard',
    "sidebarCollapsed" BOOLEAN NOT NULL DEFAULT false,
    "pinnedGroups" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "density" TEXT NOT NULL DEFAULT 'comfortable',
    "contextBusinessId" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "UserNavPreference_pkey" PRIMARY KEY ("userId"),
    CONSTRAINT "UserNavPreference_mode_check" CHECK ("mode" IN ('standard', 'advanced')),
    CONSTRAINT "UserNavPreference_density_check" CHECK ("density" IN ('comfortable', 'compact')),
    CONSTRAINT "UserNavPreference_pinnedGroups_check" CHECK (
        COALESCE(cardinality("pinnedGroups"), 0) <= 9
        AND COALESCE("pinnedGroups", ARRAY[]::TEXT[]) <@ ARRAY['dashboard', 'devices', 'remote', 'monitoring', 'patching', 'automation', 'reports', 'security', 'admin']::TEXT[]
    ),
    CONSTRAINT "UserNavPreference_contextBusinessId_check" CHECK ("contextBusinessId" IS NULL OR "contextBusinessId" ~ '^[A-Za-z0-9_-]{8,64}$')
);

-- CreateTable
CREATE TABLE "UserNavItem" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "list" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "ref" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "usedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "UserNavItem_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "UserNavItem_list_check" CHECK ("list" IN ('favorite', 'recent')),
    CONSTRAINT "UserNavItem_kind_check" CHECK ("kind" IN ('device', 'business', 'site', 'script', 'page')),
    -- A record id, or (for a page) an absolute console path with no query,
    -- fragment, `..` or `//`: never an external URL (model.ts RECORD_REF / PAGE_REF).
    CONSTRAINT "UserNavItem_ref_check" CHECK (
        ("kind" <> 'page' AND "ref" ~ '^[A-Za-z0-9_-]{8,64}$')
        OR ("kind" = 'page' AND char_length("ref") <= 120 AND "ref" ~ '^/([a-z0-9][a-z0-9-]{0,40}(/[a-z0-9][a-z0-9-]{0,40}){0,5})?$')
    )
);

-- CreateIndex
CREATE INDEX "UserNavItem_userId_list_usedAt_idx" ON "UserNavItem"("userId", "list", "usedAt");

-- CreateIndex
CREATE UNIQUE INDEX "UserNavItem_userId_list_kind_ref_key" ON "UserNavItem"("userId", "list", "kind", "ref");

-- AddForeignKey
ALTER TABLE "UserNavPreference" ADD CONSTRAINT "UserNavPreference_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserNavItem" ADD CONSTRAINT "UserNavItem_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
