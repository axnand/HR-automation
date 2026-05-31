import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

const TASK_ID = 'cmpnynenz0003i20fxbs4ddif';

async function main() {
  const task = await prisma.task.findUnique({
    where: { id: TASK_ID },
    include: {
      contact: true,
      candidateProfile: true,
      notes: { orderBy: { createdAt: 'desc' }, take: 20 },
      channelThreads: {
        include: {
          channel: { select: { id: true, type: true, name: true, status: true, requisitionId: true } },
          account: { select: { id: true, type: true, accountId: true, name: true, status: true } },
        },
        orderBy: { createdAt: 'desc' },
      },
      job: {
        select: {
          id: true,
          title: true,
          requisitionId: true,
          requisition: {
            select: {
              id: true,
              channels: { select: { id: true, type: true, name: true, status: true, sendingAccountId: true } },
            },
          },
        },
      },
    },
  });

  if (!task) {
    console.log('NO TASK FOUND for id', TASK_ID);
    return;
  }

  console.log('=== TASK ===');
  console.log({
    id: task.id,
    stage: task.stage,
    manualStage: task.manualStage,
    deletedAt: task.deletedAt,
    candidateProfileId: task.candidateProfileId,
    jobId: task.jobId,
    candidateName: task.candidateName,
    createdAt: task.createdAt,
  });

  console.log('\n=== JOB / REQUISITION ===');
  console.log(task.job);

  console.log('\n=== CANDIDATE PROFILE ===');
  console.log(task.candidateProfile);

  console.log('\n=== CONTACT ===');
  console.log(task.contact);

  console.log('\n=== NOTES (latest 20) ===');
  for (const n of task.notes) {
    console.log(`- [${n.createdAt.toISOString()}] author=${n.authorEmail} body=${JSON.stringify(n.body)}`);
  }

  console.log('\n=== REQUISITION CHANNELS ===');
  console.log(task.job?.requisition?.channels);

  console.log('\n=== CHANNEL THREADS ===');
  for (const t of task.channelThreads) {
    console.log({
      id: t.id,
      channelType: t.channel?.type,
      channelName: t.channel?.name,
      channelStatus: t.channel?.status,
      threadStatus: t.status,
      nextAttemptAt: (t as any).nextAttemptAt,
      lastAttemptAt: (t as any).lastAttemptAt,
      attemptCount: (t as any).attemptCount,
      providerChatId: (t as any).providerChatId,
      account: t.account,
      createdAt: t.createdAt,
    });
  }
}

main().catch(console.error).finally(() => prisma.$disconnect());
