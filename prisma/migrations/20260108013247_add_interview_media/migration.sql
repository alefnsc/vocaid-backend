-- CreateEnum
CREATE TYPE "MediaKind" AS ENUM ('RECORDING');

-- CreateEnum
CREATE TYPE "MediaStatus" AS ENUM ('UPLOADING', 'AVAILABLE', 'FAILED');

-- CreateTable
CREATE TABLE "interview_media" (
    "id" UUID NOT NULL,
    "interview_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "kind" "MediaKind" NOT NULL DEFAULT 'RECORDING',
    "blob_key" VARCHAR(500) NOT NULL,
    "mime_type" VARCHAR(100) NOT NULL,
    "size_bytes" INTEGER NOT NULL,
    "duration_sec" INTEGER,
    "status" "MediaStatus" NOT NULL DEFAULT 'UPLOADING',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "interview_media_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "interview_media_interview_id_key" ON "interview_media"("interview_id");

-- CreateIndex
CREATE INDEX "interview_media_user_id_idx" ON "interview_media"("user_id");

-- CreateIndex
CREATE INDEX "interview_media_status_idx" ON "interview_media"("status");

-- AddForeignKey
ALTER TABLE "interview_media" ADD CONSTRAINT "interview_media_interview_id_fkey" FOREIGN KEY ("interview_id") REFERENCES "interviews"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "interview_media" ADD CONSTRAINT "interview_media_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
