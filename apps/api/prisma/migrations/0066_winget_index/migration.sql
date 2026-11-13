-- 0.41: a read-only copy of the public winget community source's package
-- index (cdn.winget.microsoft.com/cache/source2.msix, Public/index.db), for
-- searching. Replaced whole at most daily by WingetIndexService; nothing in
-- it is installed or trusted (an install pins the installer SHA-256 from that
-- version's winget-pkgs manifest, and each computer hashes what it downloads).

CREATE TABLE "WingetPackage" (
    "packageId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "publisher" TEXT,
    "moniker" TEXT,
    "latestVersion" TEXT NOT NULL,
    CONSTRAINT "WingetPackage_pkey" PRIMARY KEY ("packageId"),
    -- The same charsets as actions/catalog.ts: an id that could not be a
    -- plan's packageId is never stored.
    CONSTRAINT "WingetPackage_id_form" CHECK (length("packageId") <= 128 AND "packageId" ~ '^[A-Za-z0-9][A-Za-z0-9+_-]{0,63}(\.[A-Za-z0-9+_-]{1,64}){1,7}$'),
    CONSTRAINT "WingetPackage_text_bounded" CHECK (length("name") <= 200 AND length("latestVersion") <= 64 AND coalesce(length("publisher"), 0) <= 120 AND coalesce(length("moniker"), 0) <= 64)
);

CREATE TABLE "WingetIndexState" (
    "id" INTEGER NOT NULL DEFAULT 1,
    "refreshedAt" TIMESTAMP(3),
    "attemptedAt" TIMESTAMP(3),
    "packages" INTEGER NOT NULL DEFAULT 0,
    "skipped" INTEGER NOT NULL DEFAULT 0,
    "sourceSha256" TEXT,
    "sourceWrittenAt" TIMESTAMP(3),
    "lastError" TEXT,
    CONSTRAINT "WingetIndexState_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "WingetIndexState_one_row" CHECK ("id" = 1)
);

-- A Platform Admin asking for the index to be read now (the sweep itself is not audited per pass).
ALTER TYPE "ActivityAction" ADD VALUE 'WINGET_INDEX_REFRESH_REQUESTED';
