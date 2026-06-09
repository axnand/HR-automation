import { prisma } from '../lib/prisma';

async function main() {
  const requisitionId = 'cmq0prkcc000012nsx8cmnx0o';

  const jobs = await prisma.job.findMany({
    where: { requisitionId }, orderBy: { createdAt: 'asc' }, select: { id: true },
  });
  const jobIds = jobs.map(j => j.id);

  // Replicate candidates route payload shaping and measure size
  const tasks = await prisma.task.findMany({
    where: { jobId: { in: jobIds } },
    orderBy: { createdAt: 'asc' },
    select: { id: true, url: true, source: true, sourceFileName: true, sourceFileUrl: true,
      status: true, analysisStatus: true, result: true, analysisResult: true,
      errorMessage: true, retryCount: true, createdAt: true },
  });

  const shaped = tasks.map(t => ({
    id: t.id, url: t.url, source: t.source, sourceFileName: t.sourceFileName ?? null,
    hasResume: !!t.sourceFileUrl, status: t.status, analysisStatus: t.analysisStatus,
    result: t.result ? JSON.parse(t.result) : null,
    analysisResult: t.analysisResult ? JSON.parse(t.analysisResult) : null,
    errorMessage: t.errorMessage ?? null, retryCount: t.retryCount, addedAt: t.createdAt,
  }));
  const candPayload = JSON.stringify({ tasks: shaped });
  console.log('Candidates endpoint task count:', tasks.length);
  console.log('Candidates payload bytes:', candPayload.length, '=', (candPayload.length/1024/1024).toFixed(2), 'MB');

  // Pipeline payload: only DONE tasks
  const doneTasks = tasks.filter(t => t.status === 'DONE');
  const pipeShaped = doneTasks.map(t => ({
    id: t.id, url: t.url,
    result: t.result ? JSON.parse(t.result) : null,
    analysisResult: t.analysisResult ? JSON.parse(t.analysisResult) : null,
  }));
  const pipePayload = JSON.stringify({ stages: pipeShaped });
  console.log('\nPipeline DONE task count:', doneTasks.length);
  console.log('Pipeline payload bytes (approx):', pipePayload.length, '=', (pipePayload.length/1024/1024).toFixed(2), 'MB');

  // Cumulative size to find where 4.5MB cutoff lands in createdAt-asc order
  let cum = 0; const LIMIT = 4.5 * 1024 * 1024;
  let cutoffIdx = -1;
  for (let i = 0; i < shaped.length; i++) {
    cum += JSON.stringify(shaped[i]).length;
    if (cum > LIMIT && cutoffIdx === -1) cutoffIdx = i;
  }
  console.log('\n4.5MB cutoff would drop tasks from index', cutoffIdx, 'onward (of', shaped.length, ')');
  if (cutoffIdx >= 0) {
    const dropped = tasks.slice(cutoffIdx);
    console.log('Dropped tasks (newest):', dropped.length);
    console.log('Dropped includes Monika?', dropped.some(t => t.id === 'cmq68h2x6000bvw47imuv0k7s'));
    console.log('Dropped includes nkp0007?', dropped.some(t => t.url.includes('nkp0007')));
  }

  // Per-task max blob sizes
  const sizes = tasks.map(t => ((t.result?.length ?? 0) + (t.analysisResult?.length ?? 0)));
  console.log('\nAvg task blob bytes:', Math.round(sizes.reduce((a,b)=>a+b,0)/sizes.length));
  console.log('Max task blob bytes:', Math.max(...sizes));
}

main().catch(console.error).finally(() => prisma.$disconnect());
