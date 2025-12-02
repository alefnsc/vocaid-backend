/**
 * Prisma Seed Script
 * Creates mock data for development and testing
 * 
 * Usage: npx prisma db seed
 * Or: npx ts-node prisma/seed.ts
 */

import { PrismaClient, InterviewStatus, PaymentStatus } from '@prisma/client';
import { clerkClient } from '@clerk/clerk-sdk-node';

const prisma = new PrismaClient();

// ========================================
// CONFIGURATION
// ========================================

// Your Clerk User ID
const TARGET_CLERK_ID = 'user_35weQzNjK0AOMAUwc6du50IOV8c';

// Mock Interview Data
const MOCK_INTERVIEWS = [
  {
    jobTitle: 'Senior Software Engineer',
    companyName: 'Google',
    jobDescription: 'We are looking for a Senior Software Engineer to join our Cloud Platform team. You will be responsible for designing and implementing scalable distributed systems. Requirements: 5+ years experience, proficiency in Go or Java, experience with Kubernetes.',
    status: InterviewStatus.COMPLETED,
    score: 85.5,
    callDuration: 1847, // ~30 minutes
    feedbackText: 'Excellent technical knowledge demonstrated. Strong communication skills. Good problem-solving approach. Areas for improvement: Could elaborate more on system design trade-offs.',
  },
  {
    jobTitle: 'Full Stack Developer',
    companyName: 'Stripe',
    jobDescription: 'Join Stripe as a Full Stack Developer to build the future of online payments. Work with React, Node.js, and Ruby. Experience with financial systems is a plus.',
    status: InterviewStatus.COMPLETED,
    score: 92.0,
    callDuration: 2103, // ~35 minutes
    feedbackText: 'Outstanding performance! Demonstrated deep understanding of both frontend and backend technologies. Excellent problem-solving skills and clear communication. Highly recommended.',
  },
  {
    jobTitle: 'DevOps Engineer',
    companyName: 'Netflix',
    jobDescription: 'Netflix is seeking a DevOps Engineer to help scale our global infrastructure. Experience with AWS, Terraform, and CI/CD pipelines required.',
    status: InterviewStatus.COMPLETED,
    score: 78.0,
    callDuration: 1520, // ~25 minutes
    feedbackText: 'Good foundational knowledge of DevOps practices. Solid AWS experience. Could improve on explaining complex infrastructure decisions. Consider preparing more examples of past projects.',
  },
  {
    jobTitle: 'Product Manager',
    companyName: 'Meta',
    jobDescription: 'Lead product strategy for Meta\'s messaging platforms. 3+ years PM experience required. Strong analytical skills and user empathy needed.',
    status: InterviewStatus.COMPLETED,
    score: 88.5,
    callDuration: 1980, // ~33 minutes
    feedbackText: 'Strong product sense and user-centric thinking. Good at prioritization frameworks. Articulate communicator. Suggestion: Provide more quantitative metrics when discussing past successes.',
  },
  {
    jobTitle: 'Machine Learning Engineer',
    companyName: 'OpenAI',
    jobDescription: 'Join OpenAI to work on cutting-edge AI research and deployment. PhD or equivalent experience in ML required. Experience with large-scale model training.',
    status: InterviewStatus.IN_PROGRESS,
    score: null,
    callDuration: null,
    feedbackText: null,
  },
];

// Mock Payment Data
const MOCK_PAYMENTS = [
  {
    packageId: 'starter',
    packageName: 'Starter Pack',
    creditsAmount: 5,
    amountUSD: 9.99,
    amountBRL: 49.95,
    status: PaymentStatus.APPROVED,
    statusDetail: 'accredited',
    paidAt: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000), // 30 days ago
  },
  {
    packageId: 'professional',
    packageName: 'Professional Pack',
    creditsAmount: 15,
    amountUSD: 24.99,
    amountBRL: 124.95,
    status: PaymentStatus.APPROVED,
    statusDetail: 'accredited',
    paidAt: new Date(Date.now() - 14 * 24 * 60 * 60 * 1000), // 14 days ago
  },
  {
    packageId: 'enterprise',
    packageName: 'Enterprise Pack',
    creditsAmount: 50,
    amountUSD: 69.99,
    amountBRL: 349.95,
    status: PaymentStatus.PENDING,
    statusDetail: 'pending_review',
    paidAt: null,
  },
];

// ========================================
// SEED FUNCTIONS
// ========================================

async function fetchClerkUser(clerkId: string) {
  console.log(`📡 Fetching user from Clerk: ${clerkId}`);
  
  try {
    const clerkUser = await clerkClient.users.getUser(clerkId);
    
    console.log('✅ User fetched from Clerk:');
    console.log(`   • Email: ${clerkUser.emailAddresses[0]?.emailAddress}`);
    console.log(`   • Name: ${clerkUser.firstName} ${clerkUser.lastName}`);
    console.log(`   • Created: ${new Date(clerkUser.createdAt).toISOString()}`);
    
    return {
      clerkId: clerkUser.id,
      email: clerkUser.emailAddresses[0]?.emailAddress || '',
      firstName: clerkUser.firstName,
      lastName: clerkUser.lastName,
      imageUrl: clerkUser.imageUrl,
      credits: (clerkUser.publicMetadata?.credits as number) || 10, // Default 10 credits for testing
    };
  } catch (error: any) {
    console.error('❌ Failed to fetch user from Clerk:', error.message);
    
    // Return fallback data if Clerk fetch fails
    console.log('⚠️ Using fallback user data');
    return {
      clerkId,
      email: 'ale.fonseca@example.com',
      firstName: 'Ale',
      lastName: 'Fonseca',
      imageUrl: null,
      credits: 10,
    };
  }
}

async function createOrUpdateUser(userData: {
  clerkId: string;
  email: string;
  firstName: string | null;
  lastName: string | null;
  imageUrl: string | null;
  credits: number;
}) {
  console.log('\n👤 Creating/updating user in database...');
  
  const user = await prisma.user.upsert({
    where: { clerkId: userData.clerkId },
    create: userData,
    update: {
      email: userData.email,
      firstName: userData.firstName,
      lastName: userData.lastName,
      imageUrl: userData.imageUrl,
      credits: userData.credits,
    },
  });
  
  console.log(`✅ User created/updated:`);
  console.log(`   • ID: ${user.id}`);
  console.log(`   • Clerk ID: ${user.clerkId}`);
  console.log(`   • Email: ${user.email}`);
  console.log(`   • Credits: ${user.credits}`);
  
  return user;
}

async function createMockInterviews(userId: string) {
  console.log('\n📝 Creating mock interviews...');
  
  const interviews = [];
  
  for (const mockInterview of MOCK_INTERVIEWS) {
    // Generate random dates within the last 60 days
    const daysAgo = Math.floor(Math.random() * 60);
    const createdAt = new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000);
    const hasStarted = mockInterview.callDuration !== null;
    const startedAt = hasStarted
      ? new Date(createdAt.getTime() + 5 * 60 * 1000) // 5 mins after creation
      : null;
    const endedAt = mockInterview.callDuration && startedAt
      ? new Date(startedAt.getTime() + mockInterview.callDuration * 1000)
      : null;
    
    // Generate a mock Retell call ID for interviews that have started
    const retellCallId = hasStarted
      ? `call_${Math.random().toString(36).substring(2, 15)}`
      : null;
    
    const interview = await prisma.interview.create({
      data: {
        userId,
        retellCallId,
        jobTitle: mockInterview.jobTitle,
        companyName: mockInterview.companyName,
        jobDescription: mockInterview.jobDescription,
        status: mockInterview.status,
        score: mockInterview.score,
        callDuration: mockInterview.callDuration,
        feedbackText: mockInterview.feedbackText,
        startedAt,
        endedAt,
        createdAt,
      },
    });
    
    interviews.push(interview);
    console.log(`   ✅ ${mockInterview.jobTitle} @ ${mockInterview.companyName} (${mockInterview.status})`);
    
    // Create metrics for completed interviews
    if (mockInterview.status === InterviewStatus.COMPLETED && mockInterview.score) {
      await createInterviewMetrics(interview.id, mockInterview.score);
    }
  }
  
  console.log(`\n📊 Total interviews created: ${interviews.length}`);
  return interviews;
}

async function createInterviewMetrics(interviewId: string, overallScore: number) {
  const categories = [
    { category: 'communication', name: 'Clarity of Expression', weight: 0.2 },
    { category: 'communication', name: 'Active Listening', weight: 0.15 },
    { category: 'technical', name: 'Problem Solving', weight: 0.25 },
    { category: 'technical', name: 'Technical Knowledge', weight: 0.2 },
    { category: 'behavioral', name: 'Confidence', weight: 0.1 },
    { category: 'behavioral', name: 'Professionalism', weight: 0.1 },
  ];
  
  for (const metric of categories) {
    // Generate score with some variance around the overall score
    const variance = (Math.random() - 0.5) * 20; // ±10 points variance
    const score = Math.max(0, Math.min(100, overallScore + variance));
    
    await prisma.interviewMetric.create({
      data: {
        interviewId,
        category: metric.category,
        metricName: metric.name,
        score: Math.round(score * 10) / 10,
        maxScore: 100,
        feedback: `Performance in ${metric.name.toLowerCase()} was ${score >= 80 ? 'excellent' : score >= 60 ? 'good' : 'needs improvement'}.`,
      },
    });
  }
}

async function createMockPayments(userId: string) {
  console.log('\n💳 Creating mock payments...');
  
  const payments = [];
  
  for (const mockPayment of MOCK_PAYMENTS) {
    // Generate mock MercadoPago ID
    const mercadoPagoId = mockPayment.status === PaymentStatus.APPROVED
      ? `${Math.floor(Math.random() * 90000000000) + 10000000000}`
      : null;
    
    const preferenceId = `pref_${Math.random().toString(36).substring(2, 15)}`;
    
    const payment = await prisma.payment.create({
      data: {
        userId,
        mercadoPagoId,
        preferenceId,
        packageId: mockPayment.packageId,
        packageName: mockPayment.packageName,
        creditsAmount: mockPayment.creditsAmount,
        amountUSD: mockPayment.amountUSD,
        amountBRL: mockPayment.amountBRL,
        status: mockPayment.status,
        statusDetail: mockPayment.statusDetail,
        paidAt: mockPayment.paidAt,
      },
    });
    
    payments.push(payment);
    console.log(`   ✅ ${mockPayment.packageName} - $${mockPayment.amountUSD} (${mockPayment.status})`);
  }
  
  console.log(`\n💰 Total payments created: ${payments.length}`);
  return payments;
}

async function clearExistingData(clerkId: string) {
  console.log('\n🧹 Clearing existing data for user...');
  
  const user = await prisma.user.findUnique({
    where: { clerkId },
    include: {
      interviews: { include: { metrics: true } },
      payments: true,
    },
  });
  
  if (user) {
    // Delete metrics first (cascade should handle this, but being explicit)
    for (const interview of user.interviews) {
      await prisma.interviewMetric.deleteMany({
        where: { interviewId: interview.id },
      });
    }
    
    // Delete interviews
    await prisma.interview.deleteMany({
      where: { userId: user.id },
    });
    
    // Delete payments
    await prisma.payment.deleteMany({
      where: { userId: user.id },
    });
    
    console.log(`   ✅ Cleared ${user.interviews.length} interviews and ${user.payments.length} payments`);
  } else {
    console.log('   ℹ️ No existing data found');
  }
}

// ========================================
// MAIN SEED FUNCTION
// ========================================

async function main() {
  console.log('🌱 Starting database seed...\n');
  console.log('═'.repeat(50));
  
  try {
    // 1. Fetch user data from Clerk
    const clerkUserData = await fetchClerkUser(TARGET_CLERK_ID);
    
    // 2. Clear existing data
    await clearExistingData(TARGET_CLERK_ID);
    
    // 3. Create/update user in database
    const user = await createOrUpdateUser(clerkUserData);
    
    // 4. Create mock interviews
    await createMockInterviews(user.id);
    
    // 5. Create mock payments
    await createMockPayments(user.id);
    
    console.log('\n═'.repeat(50));
    console.log('✅ Database seed completed successfully!');
    console.log('\n📋 Summary:');
    console.log(`   • User ID: ${user.id}`);
    console.log(`   • Clerk ID: ${user.clerkId}`);
    console.log(`   • Interviews: ${MOCK_INTERVIEWS.length}`);
    console.log(`   • Payments: ${MOCK_PAYMENTS.length}`);
    console.log('\n💡 Run "npx prisma studio" to view the data');
    
  } catch (error: any) {
    console.error('\n❌ Seed failed:', error.message);
    throw error;
  }
}

// Run seed
main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
