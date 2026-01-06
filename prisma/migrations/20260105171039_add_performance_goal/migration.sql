/*
  Warnings:

  - You are about to drop the column `feedback_pdf_storage_key` on the `interviews` table. All the data in the column will be lost.
  - You are about to drop the column `resume_file_name` on the `interviews` table. All the data in the column will be lost.
  - You are about to drop the column `resume_mime_type` on the `interviews` table. All the data in the column will be lost.
  - You are about to drop the column `resume_storage_key` on the `interviews` table. All the data in the column will be lost.
  - You are about to drop the `feedback_jsons` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `feedback_pdfs` table. If the table is not empty, all the data it contains will be lost.
  - A unique constraint covering the columns `[feedback_document_id]` on the table `interviews` will be added. If there are existing duplicate values, this will fail.
  - Made the column `resume_id` on table `interviews` required. This step will fail if there are existing NULL values in that column.

*/
-- AlterEnum
ALTER TYPE "TransactionalEmailType" ADD VALUE 'EMAIL_VERIFICATION';

-- DropForeignKey
ALTER TABLE "feedback_jsons" DROP CONSTRAINT "feedback_jsons_interview_id_fkey";

-- DropForeignKey
ALTER TABLE "feedback_pdfs" DROP CONSTRAINT "feedback_pdfs_feedback_json_id_fkey";

-- DropForeignKey
ALTER TABLE "feedback_pdfs" DROP CONSTRAINT "feedback_pdfs_interview_id_fkey";

-- DropForeignKey
ALTER TABLE "interviews" DROP CONSTRAINT "interviews_resume_id_fkey";

-- AlterTable
ALTER TABLE "interviews" DROP COLUMN "feedback_pdf_storage_key",
DROP COLUMN "resume_file_name",
DROP COLUMN "resume_mime_type",
DROP COLUMN "resume_storage_key",
ADD COLUMN     "feedback_document_id" UUID,
ALTER COLUMN "resume_id" SET NOT NULL;

-- AlterTable
ALTER TABLE "user_consents" ADD COLUMN     "linkedin_connected_at" TIMESTAMP(3),
ADD COLUMN     "linkedin_consent_at" TIMESTAMP(3),
ADD COLUMN     "linkedin_consent_version" VARCHAR(20),
ADD COLUMN     "linkedin_member_id" VARCHAR(100),
ADD COLUMN     "linkedin_sections_consented" VARCHAR(50)[] DEFAULT ARRAY[]::VARCHAR(50)[];

-- DropTable
DROP TABLE "feedback_jsons";

-- DropTable
DROP TABLE "feedback_pdfs";

-- CreateTable
CREATE TABLE "performance_goals" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "weekly_interview_goal" INTEGER NOT NULL DEFAULT 3,
    "weekly_minutes_goal" INTEGER NOT NULL DEFAULT 60,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "performance_goals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "feedback_documents" (
    "id" UUID NOT NULL,
    "interview_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "content_json" JSONB,
    "overall_score" DOUBLE PRECISION,
    "schema_version" VARCHAR(20),
    "prompt_version" VARCHAR(50),
    "model" VARCHAR(100),
    "transcription_text" TEXT,
    "feedback_text" TEXT,
    "pdf_storage_key" VARCHAR(500),
    "generated_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "feedback_documents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "chat_sessions" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "role_filter" VARCHAR(100),
    "company_filter" VARCHAR(100),
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "chat_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "chat_messages" (
    "id" UUID NOT NULL,
    "session_id" UUID NOT NULL,
    "role" VARCHAR(20) NOT NULL,
    "content" TEXT NOT NULL,
    "metadata" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "chat_messages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "linkedin_profiles" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "linkedin_member_id" VARCHAR(100),
    "profile_url" VARCHAR(500),
    "name" VARCHAR(255),
    "email" VARCHAR(255),
    "picture_url" VARCHAR(500),
    "headline" TEXT,
    "raw_sections" JSONB,
    "source" VARCHAR(30) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "linkedin_profiles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "linkedin_profile_scores" (
    "id" UUID NOT NULL,
    "profile_id" UUID NOT NULL,
    "role_key" VARCHAR(100) NOT NULL,
    "provider" "ResumeScoreProvider" NOT NULL,
    "score" DOUBLE PRECISION NOT NULL,
    "breakdown" JSONB,
    "computed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "linkedin_profile_scores_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "performance_goals_user_id_key" ON "performance_goals"("user_id");

-- CreateIndex
CREATE INDEX "performance_goals_user_id_idx" ON "performance_goals"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "feedback_documents_interview_id_key" ON "feedback_documents"("interview_id");

-- CreateIndex
CREATE INDEX "feedback_documents_user_id_idx" ON "feedback_documents"("user_id");

-- CreateIndex
CREATE INDEX "feedback_documents_generated_at_idx" ON "feedback_documents"("generated_at");

-- CreateIndex
CREATE INDEX "feedback_documents_pdf_storage_key_idx" ON "feedback_documents"("pdf_storage_key");

-- CreateIndex
CREATE INDEX "chat_sessions_user_id_idx" ON "chat_sessions"("user_id");

-- CreateIndex
CREATE INDEX "chat_sessions_is_active_idx" ON "chat_sessions"("is_active");

-- CreateIndex
CREATE INDEX "chat_sessions_updated_at_idx" ON "chat_sessions"("updated_at");

-- CreateIndex
CREATE INDEX "chat_messages_session_id_idx" ON "chat_messages"("session_id");

-- CreateIndex
CREATE INDEX "chat_messages_created_at_idx" ON "chat_messages"("created_at");

-- CreateIndex
CREATE UNIQUE INDEX "linkedin_profiles_user_id_key" ON "linkedin_profiles"("user_id");

-- CreateIndex
CREATE INDEX "linkedin_profiles_linkedin_member_id_idx" ON "linkedin_profiles"("linkedin_member_id");

-- CreateIndex
CREATE INDEX "linkedin_profile_scores_profile_id_idx" ON "linkedin_profile_scores"("profile_id");

-- CreateIndex
CREATE INDEX "linkedin_profile_scores_role_key_idx" ON "linkedin_profile_scores"("role_key");

-- CreateIndex
CREATE INDEX "linkedin_profile_scores_computed_at_idx" ON "linkedin_profile_scores"("computed_at");

-- CreateIndex
CREATE UNIQUE INDEX "linkedin_profile_scores_profile_id_role_key_provider_key" ON "linkedin_profile_scores"("profile_id", "role_key", "provider");

-- CreateIndex
CREATE UNIQUE INDEX "interviews_feedback_document_id_key" ON "interviews"("feedback_document_id");

-- CreateIndex
CREATE INDEX "interviews_feedback_document_id_idx" ON "interviews"("feedback_document_id");

-- CreateIndex
CREATE INDEX "user_consents_linkedin_consent_at_idx" ON "user_consents"("linkedin_consent_at");

-- CreateIndex
CREATE INDEX "user_consents_linkedin_connected_at_idx" ON "user_consents"("linkedin_connected_at");

-- CreateIndex
CREATE INDEX "user_consents_linkedin_member_id_idx" ON "user_consents"("linkedin_member_id");

-- AddForeignKey
ALTER TABLE "performance_goals" ADD CONSTRAINT "performance_goals_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "interviews" ADD CONSTRAINT "interviews_resume_id_fkey" FOREIGN KEY ("resume_id") REFERENCES "resume_documents"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "interviews" ADD CONSTRAINT "interviews_feedback_document_id_fkey" FOREIGN KEY ("feedback_document_id") REFERENCES "feedback_documents"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "feedback_documents" ADD CONSTRAINT "feedback_documents_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chat_sessions" ADD CONSTRAINT "chat_sessions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chat_messages" ADD CONSTRAINT "chat_messages_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "chat_sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "linkedin_profiles" ADD CONSTRAINT "linkedin_profiles_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "linkedin_profile_scores" ADD CONSTRAINT "linkedin_profile_scores_profile_id_fkey" FOREIGN KEY ("profile_id") REFERENCES "linkedin_profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE;
