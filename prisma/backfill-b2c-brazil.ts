/**
 * Backfill Script: B2C Brazil Fields
 * 
 * This script updates existing users to have:
 * - userType: PERSONAL (default for all self-signups)
 * - countryCode: BR (Brazil-only for now)
 * 
 * Run with: npx ts-node prisma/backfill-b2c-brazil.ts
 */

import { PrismaClient, UserType } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  console.log('🇧🇷 Starting B2C Brazil backfill...\n');

  // Count users before update
  const totalUsers = await prisma.user.count();
  console.log(`📊 Total users in database: ${totalUsers}`);

  // Count users missing userType or countryCode
  const usersNeedingBackfill = await prisma.user.count({
    where: {
      OR: [
        { userType: undefined },
        { countryCode: { equals: '' } }
      ]
    }
  });
  console.log(`🔄 Users needing backfill: ${usersNeedingBackfill}`);

  // Backfill userType to PERSONAL for users without it
  const userTypeResult = await prisma.user.updateMany({
    where: {
      userType: undefined
    },
    data: {
      userType: UserType.PERSONAL
    }
  });
  console.log(`✅ Updated userType to PERSONAL: ${userTypeResult.count} users`);

  // Backfill countryCode to BR for users with empty string
  const countryCodeResult = await prisma.user.updateMany({
    where: {
      countryCode: { equals: '' }
    },
    data: {
      countryCode: 'BR'
    }
  });
  console.log(`✅ Updated countryCode to BR: ${countryCodeResult.count} users`);

  // Backfill roleCountryCode on interviews without it (default to user's country)
  const interviewsWithoutCountry = await prisma.interview.findMany({
    where: {
      OR: [
        { roleCountryCode: null },
        { roleCountryCode: '' }
      ]
    },
    select: {
      id: true,
      userId: true
    }
  });

  console.log(`\n🎤 Interviews needing roleCountryCode: ${interviewsWithoutCountry.length}`);

  // Update each interview with user's countryCode
  let interviewsUpdated = 0;
  for (const interview of interviewsWithoutCountry) {
    const user = await prisma.user.findUnique({
      where: { id: interview.userId },
      select: { countryCode: true }
    });

    await prisma.interview.update({
      where: { id: interview.id },
      data: {
        roleCountryCode: user?.countryCode || 'BR'
      }
    });
    interviewsUpdated++;
  }
  console.log(`✅ Updated roleCountryCode on interviews: ${interviewsUpdated}`);

  // Verify the backfill
  console.log('\n📊 Verification:');
  
  const personalUsers = await prisma.user.count({
    where: { userType: UserType.PERSONAL }
  });
  console.log(`   PERSONAL users: ${personalUsers}`);

  const brazilUsers = await prisma.user.count({
    where: { countryCode: 'BR' }
  });
  console.log(`   Brazil (BR) users: ${brazilUsers}`);

  const interviewsWithCountry = await prisma.interview.count({
    where: {
      roleCountryCode: { not: null }
    }
  });
  console.log(`   Interviews with roleCountryCode: ${interviewsWithCountry}`);

  console.log('\n✨ Backfill complete!');
}

main()
  .catch((e) => {
    console.error('❌ Backfill failed:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
