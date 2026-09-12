import { db } from '@/lib/storage/prisma';
import { createCollaborationHandlers } from './http';
import { CollaborationService } from './service';
import { CollaborationStore, sqlDatabase } from './store';

export const collaborationHandlers = createCollaborationHandlers({
    service: new CollaborationService(new CollaborationStore(sqlDatabase(db.getClient()))),
    authenticate: async apiKey => (await db.findUserByApiKey(apiKey))?.username ?? null,
});
