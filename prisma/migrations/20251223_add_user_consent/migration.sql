-- Migration: Add User Consent Management
-- Description: Adds UserConsent table for legal consent tracking and onboardingCompletedAt to User

-- CreateEnum
CREATE TYPE "ConsentSource" AS ENUM ('FORM', 'OAUTH');

-- AlterTable: Add onboardingCompletedAt to users
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "onboarding_completed_at" TIMESTAMP(3);

-- CreateTable: user_consents
CREATE TABLE IF NOT EXISTS "user_consents" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" UUID NOT NULL,
    "terms_accepted_at" TIMESTAMP(3) NOT NULL,
    "privacy_accepted_at" TIMESTAMP(3) NOT NULL,
    "terms_version" VARCHAR(20) NOT NULL,
    "privacy_version" VARCHAR(20) NOT NULL,
    "transactional_opt_in" BOOLEAN NOT NULL DEFAULT true,
    "marketing_opt_in" BOOLEAN NOT NULL DEFAULT false,
    "marketing_opt_in_at" TIMESTAMP(3),
    "marketing_version" VARCHAR(20),
    "ip_address" VARCHAR(45),
    "user_agent" TEXT,
    "source" "ConsentSource" NOT NULL DEFAULT 'FORM',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_consents_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "user_consents_user_id_key" ON "user_consents"("user_id");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "user_consents_terms_accepted_at_idx" ON "user_consents"("terms_accepted_at");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "user_consents_privacy_accepted_at_idx" ON "user_consents"("privacy_accepted_at");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "user_consents_marketing_opt_in_idx" ON "user_consents"("marketing_opt_in");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "user_consents_source_idx" ON "user_consents"("source");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "users_onboarding_completed_at_idx" ON "users"("onboarding_completed_at");

-- AddForeignKey
ALTER TABLE "user_consents" ADD CONSTRAINT "user_consents_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
