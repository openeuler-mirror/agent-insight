import { NextResponse } from 'next/server';
import { resolveUser } from '@/lib/auth/auth';
import { prisma } from '@/lib/storage/prisma';
import { archiveAsset, createAsset, listAssets, listCredentials, saveCredential, type AssetKind } from '@/lib/evaluation-harness/store';
import { bootstrap } from '@/lib/evaluation-harness/catalog';
import { cancelRun, createRun, startRun, recoverInterruptedRuns, generateDataset, reviseDataset, runDetail, staticAnalysis } from '@/lib/evaluation-harness/service';
import { existingDatasets, importDataset } from '@/lib/evaluation-harness/imports';
import { getActiveConfig } from '@/lib/storage/server-config';
class AuthenticationError extends Error {}
export const dynamic = 'force-dynamic';
async function identity(req: Request) {
  if (process.env.DB_HOST) throw new Error('版本化多轮实验第一版需要 SQLite 存储');
  const {
    username
  } = await resolveUser(req);
  if (!username) throw new AuthenticationError('请登录并提供有效 API Key');
  return username;
}
export async function GET(req: Request) {
  try {
    const user = await identity(req),
      q = new URL(req.url).searchParams;
    await recoverInterruptedRuns(user);
    if (q.get('experimentId')) return NextResponse.json(await runDetail(user, q.get('experimentId')!));
    if(q.get('traceId')){
      const row=await prisma.experimentCase.findFirst({where:{executionId:q.get('traceId')!,experiment:{user,scope:'evaluation-harness'}},select:{id:true,experimentId:true}});
      if(!row)return NextResponse.json({error:'Trace 不存在或无权访问'},{status:404});
      const detail=await runDetail(user,row.experimentId),index=detail.experiment.cases.findIndex((c:any)=>c.id===row.id),result=detail.results[index];
      return NextResponse.json({experimentId:row.experimentId,caseId:row.id,experimentName:detail.experiment.name,traceId:q.get('traceId'),case:result.case,turns:result.evidence,execution:detail.manifest.execution||{endpoint:detail.manifest.target.content.endpoint,model:detail.manifest.target.content.model}});
    }
    const [assets, credentials, runs] = await Promise.all([listAssets(user), listCredentials(user), prisma.experiment.findMany({
      where: {
        user,
        scope: 'evaluation-harness'
      },
      orderBy: {
        createdAt: 'desc'
      },
      take: 100,
      select: {
        id: true,
        name: true,
        status: true,
        configSnapshotJson: true,
        createdAt: true
      }
    })]);
    const reports = await prisma.evaluationAnalysis.findMany({
      where: {
        user,
        targetId: {
          in: runs.map((r: any) => r.id)
        }
      },
      orderBy: {
        createdAt: 'desc'
      }
    });
    const dayStart=new Date();dayStart.setHours(0,0,0,0);
    const [publicModel,todayCount,runningCount,failedCount]=await Promise.all([getActiveConfig(user),prisma.experiment.count({where:{user,scope:'evaluation-harness',createdAt:{gte:dayStart}}}),prisma.experiment.count({where:{user,scope:'evaluation-harness',status:'running'}}),prisma.experiment.count({where:{user,scope:'evaluation-harness',status:'failed'}})]);
    return NextResponse.json({
      statistics:{todayCount,runningCount,failedCount},
      executionOptions: {
        demoEndpoint: process.env.EVALUATION_DEMO_URL || '',
        demoModels: ['demo-basic', 'demo-reasoning'],
        publicModel: publicModel?.model || '',
        publicModelConfigured: Boolean(publicModel?.model && publicModel?.baseUrl && publicModel?.apiKey)
      },
      legacyDatasets: await existingDatasets(user),
      assets: assets.map((a: any) => ({
        ...a,
        content: JSON.parse(a.contentJson)
      })),
      credentials,
      runs: runs.map((r: any) => ({
        ...r,
        manifest: JSON.parse(r.configSnapshotJson || '{}'),
        summary: JSON.parse(reports.find((x: any) => x.targetId === r.id)?.reportJson || '{}').summary,
        groupSummaries: JSON.parse(reports.find((x: any) => x.targetId === r.id)?.reportJson || '{}').groups || []
      }))
    });
  } catch (e) {
    return NextResponse.json({
      error: (e as Error).message
    }, {
      status: e instanceof AuthenticationError ? 401 : 400
    });
  }
}
export async function POST(req: Request) {
  try {
    const user = await identity(req);
    const raw = await req.text();
    if (raw.length > 2000000) throw new Error('请求内容过大');
    const b = JSON.parse(raw);
    switch (b.action) {
      case 'archive':
        if (typeof b.archived !== 'boolean') throw new Error('archived 需要布尔值');
        return NextResponse.json(await archiveAsset(user, b.id, b.archived));
      case 'import-dataset':
        return NextResponse.json(await importDataset(user, b.id));
      case 'bootstrap':
        await bootstrap(user);
        return NextResponse.json({
          ok: true
        });
      case 'asset':
        if (!['target', 'dataset', 'evaluator'].includes(b.kind)) throw new Error('无效资产类型');
        return NextResponse.json(await createAsset(user, b.kind as AssetKind, b.assetKey, b.name, b.content));
      case 'credential':
        return NextResponse.json(await saveCredential(user, b.name, b.config));
      case 'generate':
        return NextResponse.json(await generateDataset(user, b.targetId, b.credentialId));
      case 'static':
        return NextResponse.json(await staticAnalysis(user, b.targetId));
      case 'create':
        return NextResponse.json({
          id: await createRun(user, b.config)
        });
      case 'run':
        {
          await startRun(user, b.id);
          return NextResponse.json({
            id: b.id,
            status: 'accepted'
          }, {
            status: 202
          });
        }
      case 'cancel':
        return NextResponse.json({
          cancelled: await cancelRun(user, b.id)
        });
      case 'revise':
        return NextResponse.json(await reviseDataset(user, b.experimentId, b.caseId, b.case));
      default:
        throw new Error('不支持的操作');
    }
  } catch (e) {
    const message = (e as Error).message;
    return NextResponse.json({
      error: message.startsWith('Invalid') ? '输入数据无效' : message.slice(0, 600)
    }, {
      status: e instanceof AuthenticationError ? 401 : 400
    });
  }
}
