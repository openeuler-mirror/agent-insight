/*
 * Copyright (c) 2026 Huawei Technologies Co., Ltd.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */
'use client';
import {useState} from 'react';
import {Button} from '@/components/ui/button';
import {Dialog,DialogContent,DialogDescription,DialogHeader,DialogTitle} from '@/components/ui/dialog';
import {AssetVersionPicker} from './AssetVersionPicker';
import {agentAssetBusinessId} from '@/lib/evaluation-assets/identity';

export function AgentEvaluationVersions({platform,name}:{platform:string;name:string}){
  const [open,setOpen]=useState(false);
  return <><Button type="button" variant="outline" size="sm" onClick={()=>setOpen(true)}>评测版本</Button>
    <Dialog open={open} onOpenChange={setOpen}><DialogContent><DialogHeader><DialogTitle>{name} · 评测版本</DialogTitle><DialogDescription>平台：{platform}。外部 Agent 的代码变化需要手动登记，版本记录不会修改执行端。</DialogDescription></DialogHeader>
      {open&&<AssetVersionPicker kind="agent" businessId={agentAssetBusinessId(platform,name)} allowNewAgent/>}
    </DialogContent></Dialog>
  </>;
}
