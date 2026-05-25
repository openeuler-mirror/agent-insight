
import { config } from 'dotenv';
config();

import { PrismaClient } from '@prisma/client';
import { getDatabaseAdapter, DatabaseAdapter } from '@/lib/storage/db-interface';

const globalForPrisma = global as unknown as { prisma: PrismaClient };

function createPrismaClient(): PrismaClient {
  return new PrismaClient();
}

export const prismaRaw = globalForPrisma.prisma || createPrismaClient();

if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = prismaRaw;

export const db: DatabaseAdapter = getDatabaseAdapter();

export const prisma = process.env.DB_HOST ? createPrismaCompatibleWrapper(db) : prismaRaw;

function createPrismaCompatibleWrapper(adapter: DatabaseAdapter): any {
    const client = adapter.getClient();
    
    if (client instanceof PrismaClient) {
        return client;
    }
    
    return {
        user: {
            findUnique: async (args: any) => {
                if (args.where?.apiKey) return adapter.findUserByApiKey(args.where.apiKey);
                if (args.where?.username) return adapter.findUserByUsername(args.where.username);
                return null;
            },
            findFirst: async (args: any) => {
                if (args.where?.username) return adapter.findUserByUsername(args.where.username);
                return null;
            }
        },
        skill: {
            findFirst: async (args: any) => {
                const name = args.where?.name;
                const user = args.where?.OR?.[0]?.user ?? args.where?.OR?.[1]?.user;
                return adapter.findSkill(name, user);
            },
            findMany: async (args: any) => {
                return adapter.findSkills(args.where || {});
            },
            findUnique: async (args: any) => {
                return adapter.findSkill(args.where?.name, args.where?.user);
            },
            delete: async (args: any) => {
                console.warn('[OpenGaussAdapter] skill.delete not fully implemented');
                return null;
            }
        },
        skillVersion: {
            findFirst: async (args: any) => {
                if (args.where?.skillId) {
                    return adapter.findLatestSkillVersion(args.where.skillId);
                }
                return null;
            }
        },
        config: {
            findMany: async (args: any) => {
                return adapter.findConfigs(args.where || {});
            }
        },
        session: {
            findUnique: async (args: any) => {
                if (args.where?.taskId) return adapter.findSessionByTaskId(args.where.taskId);
                return null;
            },
            update: async (args: any) => {
                if (args.where?.id) return adapter.updateSession(args.where.id, args.data);
                return null;
            },
            upsert: async (args: any) => {
                const taskId = args.where?.taskId;
                if (!taskId) return null;
                return adapter.upsertSession(taskId, args.create, args.update);
            }
        },
        execution: {
            findUnique: async (args: any) => {
                if (args.where?.id) return adapter.findExecutionById(args.where.id);
                return null;
            },
            upsert: async (args: any) => {
                return adapter.upsertExecution(args);
            },
            findMany: async (args: any) => {
                return adapter.findExecutions(args.where, args.orderBy);
            },
            update: async (args: any) => {
                if (args.where?.id) return adapter.updateExecution(args.where.id, args.data);
                return null;
            }
        },
        debugHistory: {
            findMany: async (args: any) => {
                // For now, return empty if not implemented in adapter
                // In SQLite mode, this wrapper won't be used
                console.warn('[PrismaWrapper] debugHistory.findMany not implemented in adapter');
                return [];
            },
            create: async (args: any) => {
                console.warn('[PrismaWrapper] debugHistory.create not implemented in adapter');
                return null;
            },
            deleteMany: async (args: any) => {
                console.warn('[PrismaWrapper] debugHistory.deleteMany not implemented in adapter');
                return { count: 0 };
            }
        }
    };
}
