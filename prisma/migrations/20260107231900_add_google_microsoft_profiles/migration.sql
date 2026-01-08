-- CreateTable
CREATE TABLE "google_profiles" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "google_id" VARCHAR(100) NOT NULL,
    "email" VARCHAR(255),
    "name" VARCHAR(255),
    "picture_url" VARCHAR(500),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "google_profiles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "microsoft_profiles" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "ms_user_id" VARCHAR(100) NOT NULL,
    "email" VARCHAR(255),
    "name" VARCHAR(255),
    "picture_url" VARCHAR(500),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "microsoft_profiles_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "google_profiles_user_id_key" ON "google_profiles"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "google_profiles_google_id_key" ON "google_profiles"("google_id");

-- CreateIndex
CREATE INDEX "google_profiles_google_id_idx" ON "google_profiles"("google_id");

-- CreateIndex
CREATE UNIQUE INDEX "microsoft_profiles_user_id_key" ON "microsoft_profiles"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "microsoft_profiles_ms_user_id_key" ON "microsoft_profiles"("ms_user_id");

-- CreateIndex
CREATE INDEX "microsoft_profiles_ms_user_id_idx" ON "microsoft_profiles"("ms_user_id");

-- AddForeignKey
ALTER TABLE "google_profiles" ADD CONSTRAINT "google_profiles_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "microsoft_profiles" ADD CONSTRAINT "microsoft_profiles_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
