import {isStorageCoreEnabled} from '@/lib/storage-core/mode';
import {CoreCollaborationStore} from '@/lib/storage-core/collaboration-store';
import {getCoreControlContext} from '@/lib/storage-core/control-context';
import {semanticRoute} from '@/lib/storage-core/semantic-sources';
/*
 * Copyright (c) 2026 Huawei Technologies Co., Ltd.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { CollaborationProjection } from './projection';
import { db } from '@/lib/storage/prisma';
import { createCollaborationHandlers } from './http';
import { CollaborationService } from './service';
import { CollaborationStore, sqlDatabase } from './store';


export const collaborationService = new CollaborationService((new CoreCollaborationStore()));

const originalHandlers = createCollaborationHandlers({
    service: collaborationService,
    authenticate: async apiKey => (getCoreControlContext()?.actor.username??null),
});

export const collaborationTraceProjection = new CollaborationProjection(collaborationService);

export const collaborationHandlers={report:(request:Request)=>semanticRoute(request,()=>originalHandlers.report(request)),bind:(request:Request)=>semanticRoute(request,()=>originalHandlers.bind(request)),graph:(request:Request,id:string)=>semanticRoute(request,()=>originalHandlers.graph(request,id))};
