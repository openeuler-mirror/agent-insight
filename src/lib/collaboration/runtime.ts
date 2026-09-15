import { db } from '@/lib/storage/prisma';
import { createCollaborationHandlers } from './http';
import { CollaborationService } from './service';
import { CollaborationStore, sqlDatabase } from './store';

import { CollaborationProjection } from './projection';

export const collaborationService = new CollaborationService(new CollaborationStore(sqlDatabase(db.getClient())));
export const collaborationProjection = new CollaborationProjection(collaborationService);

export const collaborationHandlers = createCollaborationHandlers({
    service: collaborationService,
    authenticate: async apiKey => (await db.findUserByApiKey(apiKey))?.username ?? null,
});
