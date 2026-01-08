-- CreateTable
CREATE TABLE "x_profiles" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "x_user_id" VARCHAR(100) NOT NULL,
    "username" VARCHAR(100),
    "name" VARCHAR(255),
    "picture_url" VARCHAR(500),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "x_profiles_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "x_profiles_user_id_key" ON "x_profiles"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "x_profiles_x_user_id_key" ON "x_profiles"("x_user_id");

-- CreateIndex
CREATE INDEX "x_profiles_x_user_id_idx" ON "x_profiles"("x_user_id");

-- AddForeignKey
ALTER TABLE "x_profiles" ADD CONSTRAINT "x_profiles_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
