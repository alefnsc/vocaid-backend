import { PrismaClient, InterviewStatus } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  const clerkId = 'user_35weQzNjK0AOMAUwc6du50IOV8c';
  
  // Find the user
  const user = await prisma.user.findUnique({
    where: { clerkId }
  });

  if (!user) {
    console.error('User not found with clerkId:', clerkId);
    process.exit(1);
  }

  console.log('Found user:', user.email);

  // Delete existing interviews for this user (to avoid duplicates)
  await prisma.interviewMetric.deleteMany({
    where: { interview: { userId: user.id } }
  });
  await prisma.interview.deleteMany({
    where: { userId: user.id }
  });

  console.log('Cleared existing interviews');

  // Create mock interviews
  const interviews = [
    {
      jobTitle: 'Senior Frontend Developer',
      companyName: 'Google',
      jobDescription: 'Building next-generation web applications using React, TypeScript, and modern frontend technologies. Working with design systems and accessibility standards.',
      status: InterviewStatus.COMPLETED,
      score: 8.5,
      callDuration: 900, // 15 minutes
      startedAt: new Date('2025-11-25T10:00:00Z'),
      endedAt: new Date('2025-11-25T10:15:00Z'),
      feedbackText: 'Excellent technical knowledge demonstrated. Strong communication skills and good problem-solving approach.',
      retellCallId: 'mock_call_001',
    },
    {
      jobTitle: 'Full Stack Engineer',
      companyName: 'Meta',
      jobDescription: 'Developing scalable web applications with React, Node.js, and GraphQL. Focus on performance optimization and user experience.',
      status: InterviewStatus.COMPLETED,
      score: 7.8,
      callDuration: 840, // 14 minutes
      startedAt: new Date('2025-11-20T14:00:00Z'),
      endedAt: new Date('2025-11-20T14:14:00Z'),
      feedbackText: 'Good understanding of full-stack concepts. Could improve on system design explanations.',
      retellCallId: 'mock_call_002',
    },
    {
      jobTitle: 'React Developer',
      companyName: 'Netflix',
      jobDescription: 'Building streaming platform interfaces with React and Redux. Focus on performance and seamless user experiences.',
      status: InterviewStatus.COMPLETED,
      score: 9.2,
      callDuration: 780, // 13 minutes
      startedAt: new Date('2025-11-15T09:00:00Z'),
      endedAt: new Date('2025-11-15T09:13:00Z'),
      feedbackText: 'Outstanding React knowledge. Excellent understanding of state management and performance optimization.',
      retellCallId: 'mock_call_003',
    },
    {
      jobTitle: 'Software Engineer',
      companyName: 'Amazon',
      jobDescription: 'Working on AWS services and building distributed systems. Strong focus on scalability and reliability.',
      status: InterviewStatus.COMPLETED,
      score: 7.2,
      callDuration: 720, // 12 minutes
      startedAt: new Date('2025-11-10T16:00:00Z'),
      endedAt: new Date('2025-11-10T16:12:00Z'),
      feedbackText: 'Solid technical foundation. Would benefit from more experience with distributed systems.',
      retellCallId: 'mock_call_004',
    },
    {
      jobTitle: 'Backend Developer',
      companyName: 'Stripe',
      jobDescription: 'Building payment infrastructure with Node.js, PostgreSQL, and microservices architecture.',
      status: InterviewStatus.COMPLETED,
      score: 8.8,
      callDuration: 870, // 14.5 minutes
      startedAt: new Date('2025-11-05T11:00:00Z'),
      endedAt: new Date('2025-11-05T11:14:30Z'),
      feedbackText: 'Excellent understanding of backend concepts and API design. Strong database knowledge.',
      retellCallId: 'mock_call_005',
    },
  ];

  // Create interviews with metrics
  for (const interviewData of interviews) {
    const interview = await prisma.interview.create({
      data: {
        userId: user.id,
        ...interviewData,
        createdAt: interviewData.startedAt,
      }
    });

    console.log(`Created interview: ${interview.jobTitle} at ${interview.companyName}`);

    // Create metrics for each interview
    const metrics = [
      {
        category: 'communication',
        metricName: 'Clarity of Expression',
        score: Math.min(10, (interviewData.score || 7) + Math.random() * 1.5 - 0.75),
        maxScore: 10,
        feedback: 'Communicated ideas clearly and concisely.',
      },
      {
        category: 'communication',
        metricName: 'Active Listening',
        score: Math.min(10, (interviewData.score || 7) + Math.random() * 1.5 - 0.75),
        maxScore: 10,
        feedback: 'Demonstrated good listening skills and addressed questions directly.',
      },
      {
        category: 'technical',
        metricName: 'Technical Knowledge',
        score: Math.min(10, (interviewData.score || 7) + Math.random() * 1.5 - 0.75),
        maxScore: 10,
        feedback: 'Showed strong understanding of relevant technologies.',
      },
      {
        category: 'technical',
        metricName: 'Problem Solving',
        score: Math.min(10, (interviewData.score || 7) + Math.random() * 1.5 - 0.75),
        maxScore: 10,
        feedback: 'Applied logical approach to technical challenges.',
      },
      {
        category: 'behavioral',
        metricName: 'Professionalism',
        score: Math.min(10, (interviewData.score || 7) + Math.random() * 1.5 - 0.75),
        maxScore: 10,
        feedback: 'Maintained professional demeanor throughout.',
      },
      {
        category: 'behavioral',
        metricName: 'Confidence',
        score: Math.min(10, (interviewData.score || 7) + Math.random() * 1.5 - 0.75),
        maxScore: 10,
        feedback: 'Displayed appropriate confidence in responses.',
      },
    ];

    for (const metric of metrics) {
      await prisma.interviewMetric.create({
        data: {
          interviewId: interview.id,
          ...metric,
          score: parseFloat(metric.score.toFixed(1)),
        }
      });
    }

    console.log(`  Created ${metrics.length} metrics`);
  }

  console.log('\n✅ Mock data created successfully!');
  console.log(`   - ${interviews.length} interviews`);
  console.log(`   - ${interviews.length * 6} metrics`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
