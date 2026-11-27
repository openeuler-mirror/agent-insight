/*
 * Copyright (c) 2026 Huawei Technologies Co., Ltd.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

import {apiFetch} from './api';

export type AssetKind='agent'|'dataset'|'evaluator';
export interface PublishedAssetVersion {id:string;assetId:string;version:number;contentHash:string;note:string;source:string;createdAt:string;content:Record<string,unknown>}
export interface AssetVersionView {
  head:{id:string;user:string;kind:AssetKind;businessId:string;publishedVersion:number;revision:number;archived:boolean};
  versions:Array<Omit<PublishedAssetVersion,'content'>>;
  selectedVersion:PublishedAssetVersion;
  draft:{assetId:string;baseVersion:number;revision:number;content:Record<string,unknown>}|null;
  readOnly:boolean;
}
export async function evaluationAssetRequest<T>(apiKey:string,options:{query?:URLSearchParams;body?:unknown;signal?:AbortSignal}={}):Promise<T>{
  const response=await apiFetch('/api/evaluation-assets'+(options.query?'?'+options.query.toString():''),{
    method:options.body?'POST':'GET',headers:{'content-type':'application/json','x-witty-api-key':apiKey},signal:options.signal,
    ...(options.body?{body:JSON.stringify(options.body)}:{}),
  });
  const data=await response.json();
  if(!response.ok)throw Object.assign(new Error(data.error||'版本操作失败'),{status:response.status});
  return data as T;
}
