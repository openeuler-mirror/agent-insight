/*
 * Copyright (c) 2026 Huawei Technologies Co., Ltd.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

import { NextResponse } from 'next/server';
import { resolveUser } from '@/lib/auth/auth';
import { assetVersionView, mutateAsset } from '@/lib/evaluation-assets/service';
import { ASSET_KINDS, EvaluationAssetError, type AssetKind } from '@/lib/evaluation-assets/types';
import { EvaluatorSkillError } from '@/lib/evaluators/evaluator-skill-store';
import { GenerationError } from '@/lib/trace-datasets/contracts';

export const dynamic='force-dynamic';
function failure(error:unknown){
  if(error instanceof EvaluationAssetError)return NextResponse.json({error:error.message,code:error.code},{status:error.status});
  if(error instanceof EvaluatorSkillError||error instanceof GenerationError)return NextResponse.json({error:error.message},{status:error.status});
  if(error&&typeof error==='object'&&'issues' in error)return NextResponse.json({error:'逐轮配置或资产内容无效'},{status:422});
  return NextResponse.json({error:'资产版本操作失败'},{status:500});
}
export async function GET(request:Request){
  try{
    const {username}=await resolveUser(request);
    if(!username)return NextResponse.json({error:'请登录后查看版本'},{status:401});
    const params=new URL(request.url).searchParams,kind=params.get('kind') as AssetKind,businessId=params.get('businessId') || '';
    if(!ASSET_KINDS.includes(kind)||!businessId)return NextResponse.json({error:'资产类型和标识必填'},{status:400});
    return NextResponse.json(await assetVersionView(username,kind,businessId,params.get('versionId') || undefined));
  }catch(error){return failure(error);}
}
export async function POST(request:Request){
  try{
    const {username}=await resolveUser(request);
    if(!username)return NextResponse.json({error:'请登录后修改版本'},{status:401});
    return NextResponse.json(await mutateAsset(username,await request.json()));
  }catch(error){return failure(error);}
}
