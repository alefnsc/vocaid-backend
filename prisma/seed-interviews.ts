import { PrismaClient, InterviewStatus } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  const clerkId = 'user_35weQzNjK0AOMAUwc6du50IOV8c';
  
  const user = await prisma.user.findUnique({
    where: { clerkId }
  });
  
  if (!user) {
    console.error('User not found with clerkId:', clerkId);
    process.exit(1);
  }
  
  console.log('Found user:', user.email);
  
  const interviews = [
    {
      userId: user.id,
      retellCallId: 'call_mock_' + Date.now() + '_1',
      jobTitle: 'Senior Frontend Developer',
      companyName: 'TechCorp Inc.',
      jobDescription: 'We are looking for a Senior Frontend Developer with 5+ years of experience in React, TypeScript, and modern web technologies.',
      status: InterviewStatus.COMPLETED,
      score: 8.5,
      feedbackText: 'Excellent technical knowledge demonstrated. Strong communication skills.',
      callDuration: 920,
      startedAt: new Date('2025-11-25T14:00:00Z'),
      endedAt: new Date('2025-11-25T14:15:20Z'),
    },
    {
      userId: user.id,
      retellCallId: 'call_mock_' + Date.now() + '_2',
      jobTitle: 'Full Stack Engineer',
      companyName: 'StartupXYZ',
      jobDescription: 'Join our fast-growing startup as a Full Stack Engineer. Work with Node.js, React, PostgreSQL.',
      status: InterviewStatus.COMPLETED,
      score: 7.8,
      feedbackText: 'Good understanding of full-stack concepts. Backend knowledge was solid.',
      callDuration: 845,
      startedAt: new Date('2025-11-28T10:30:00Z'),
      endedAt: new Date('2025-11-28T10:44:05Z'),
    },
    {
      userId: user.id,
      retellCallId: 'call_mock_' + Date.now() + '_3',
      jobTitle: 'React Developer',
      companyName: 'Digital Agency Co.',
      jobDescription: 'Looking for a React Developer to join our agency team. Work on diverse client projects.',
      status: InterviewStatus.COMPLETED,
      score: 9.2,
      feedbackText: 'Outstanding performance! Deep React knowledge with excellent examples.',
      callDuration: 780,
      startedAt: new Date('2025-11-30T16:00:00Z'),
      endedAt: new Date('2025-11-30T16:13:00Z'),
    },
    {
      userId: user.id,
      retellCallId: 'call_mock_' + Date.now() + '_4',
      jobTitle: 'Software Engineer II',
      companyName: 'BigTech Solutions',
      jobDescription: 'Software Engineer position focused on building scalable microservices.',
      status: InterviewStatus.COMPLETED,
      score: 6.5,
      feedbackText: 'Solid fundamentals but could improve on distributed systems concepts.',
      callDuration: 900,
      startedAt: new Date('2025-12-01T09:00:00Z'),
      endedAt: new Date('2025-12-01T09:15:00Z'),
    },
  ];
  
  console.log('\nCreating mock interviews...');
  
  for (const interviewData of interviews) {
    const interview = await prisma.interview.create({
      data: interviewData
    });
    console.log('Created interview:', interview.jobTitle, 'at', interview.companyName);
    
    const metrics = [
      { category: 'communication', metricName: 'Clarity of Speech', score: 8.2, maxScore: 10, feedback: 'Clear communication.' },
      { category: 'communication', metricName: 'Active Listening', score: 7.8, maxScore: 10, feedback: 'Good listening skills.' },
      { category: 'technical', metricName: 'Problem Solving', score: 7.5, maxScore: 10, feedback: 'Logical approach.' },
      { category: 'technical', metricName: 'Technical Knowledge', score: 8.0, maxScore: 10, feedback: 'Strong understanding.' },
      { category: 'behavioral', metricName: 'Teamwork', score: 8.5, maxScore: 10, feedback: 'Good collaboration.' },
      { category: 'behavioral', metricName: 'Adaptability', score: 7.9, maxScore: 10, feedback: 'Flexible approach.' },
    ];
    
    for (const metric of metrics) {
      await prisma.interviewMetric.create({
        data: {
          interviewId: interview.id,
          ...metric
        }
      });
    }
  }
  
  console.log('\nMock data created successfully!');
}

main()
  .catch((e) => {
    console.error('Error:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
