-- CreateEnum
CREATE TYPE "LeadType" AS ENUM ('EARLY_ACCESS', 'DEMO_REQUEST');

-- CreateEnum
CREATE TYPE "CompanySizeTier" AS ENUM ('STARTUP', 'SMALL', 'MEDIUM', 'ENTERPRISE');

-- CreateTable
CREATE TABLE "leads" (
    "id" UUID NOT NULL,
    "type" "LeadType" NOT NULL,
    "email" VARCHAR(320) NOT NULL,
    "name" VARCHAR(200) NOT NULL,
    "company_name" VARCHAR(200),
    "company_size_tier" "CompanySizeTier",
    "phone_e164" VARCHAR(20),
    "interested_modules" VARCHAR(50)[],
    "source" VARCHAR(50),
    "ip_address" VARCHAR(45),
    "user_agent" VARCHAR(500),
    "referrer" VARCHAR(500),
    "contacted" BOOLEAN NOT NULL DEFAULT false,
    "contacted_at" TIMESTAMP(3),
    "contact_notes" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "leads_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "leads_type_idx" ON "leads"("type");

-- CreateIndex
CREATE INDEX "leads_email_idx" ON "leads"("email");

-- CreateIndex
CREATE INDEX "leads_company_size_tier_idx" ON "leads"("company_size_tier");

-- CreateIndex
CREATE INDEX "leads_contacted_idx" ON "leads"("contacted");

-- CreateIndex
CREATE INDEX "leads_created_at_idx" ON "leads"("created_at");

-- CreateIndex
CREATE UNIQUE INDEX "leads_type_email_key" ON "leads"("type", "email");
