-- CreateEnum
CREATE TYPE "PaymentProvider" AS ENUM ('MERCADOPAGO', 'PAYPAL');

-- AlterTable: Add multilingual session tracking fields to interviews
ALTER TABLE "interviews" 
ADD COLUMN IF NOT EXISTS "agent_id" VARCHAR(100),
ADD COLUMN IF NOT EXISTS "voice_id" VARCHAR(100);

-- AlterTable: Add multi-provider payment support
ALTER TABLE "payments" 
ADD COLUMN IF NOT EXISTS "provider" "PaymentProvider" NOT NULL DEFAULT 'MERCADOPAGO',
ADD COLUMN IF NOT EXISTS "webhook_idempotency_key" VARCHAR(255),
ADD COLUMN IF NOT EXISTS "webhook_processed_at" TIMESTAMP(3);

-- CreateIndex: Unique constraint for webhook idempotency
CREATE UNIQUE INDEX IF NOT EXISTS "payments_webhook_idempotency_key_key" ON "payments"("webhook_idempotency_key");

-- CreateIndex: Index for provider-based queries
CREATE INDEX IF NOT EXISTS "payments_provider_idx" ON "payments"("provider");

-- CreateIndex: Index for agent-based queries
CREATE INDEX IF NOT EXISTS "interviews_agent_id_idx" ON "interviews"("agent_id");
