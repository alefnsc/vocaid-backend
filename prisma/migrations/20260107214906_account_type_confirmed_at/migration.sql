-- AlterTable
ALTER TABLE "users" ADD COLUMN     "account_type_confirmed_at" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "users_account_type_confirmed_at_idx" ON "users"("account_type_confirmed_at");
