import {isStorageCoreEnabled} from '@/lib/storage-core/mode';
import {controlClient} from '@/lib/storage-core/control-repository';
import {lookupCoreControlUserByKey,currentCoreControlUser} from '@/lib/storage-core/control-auth';
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

import { loadAgentInsightEnv } from '@/lib/env';
loadAgentInsightEnv();



import type { ExtendedPrismaClient } from '@/lib/storage/prisma-client';

export interface DatabaseAdapter {
    // Session operations
    createSession(data: any): Promise<any>;
    updateSession(taskId: string, data: any): Promise<any>;
    upsertSession(taskId: string, createData: any, updateData: any): Promise<any>;
    findSessionByTaskId(taskId: string): Promise<any>;
    findSessions(where: any): Promise<any[]>;

    // User operations
    findUserByApiKey(apiKey: string): Promise<any>;
    findUserByUsername(username: string): Promise<any>;
    findUserByExternalAccount(externalAccount: string): Promise<any>;
    updateUserExternalAccount(username: string, externalAccount: string): Promise<any>;
    createUser(data: any): Promise<any>;

    // Skill operations
    findSkill(name: string, user: string | null): Promise<any>;
    findSkillById(id: string): Promise<any>;
    createSkill(data: any): Promise<any>;
    updateSkill(id: string, data: any): Promise<any>;
    deleteSkill(id: string): Promise<any>;
    findSkills(where: any): Promise<any[]>;

    // Skill Version operations
    findLatestSkillVersion(skillId: string): Promise<any>;
    createSkillVersion(data: any): Promise<any>;
    deleteSkillVersion(skillId: string, version: number): Promise<any>;
    findSkillVersion(skillId: string, version: number): Promise<any>;
    findSkillVersionBySemanticVersion(skillId: string, semanticVersion: string): Promise<any>;

    // Config operations
    findConfigs(where: any): Promise<any[]>;
    findConfigById(id: string): Promise<any>;
    createConfig(data: any): Promise<any>;
    updateConfig(id: string, data: any): Promise<any>;

    // Execution operations
    findExecutionById(id: string): Promise<any>;
    // select: 可选列投影(Prisma select 形态,如 { id: true, taskId: true }）。仅 PrismaAdapter 实现，
    // 用于轻量列表查询排除 finalResult 等大字段；OpenGaussAdapter 忽略它（返回全列，与既有行为一致）。
    findExecutions(where: any, orderBy?: any, select?: Record<string, boolean>): Promise<any[]>;
    upsertExecution(data: any): Promise<any>;
    updateExecution(id: string, data: any): Promise<any>;
    deleteExecution(id: string): Promise<boolean>;
    deleteExecutions(where: any): Promise<number>;

    // UserSettings operations
    findUserSettings(user: string): Promise<any>;
    upsertUserSettings(user: string, settingsJson: string): Promise<any>;

    // ParsedFlow operations
    findParsedFlow(skillId: string, version: number, user: string | null): Promise<any>;
    upsertParsedFlow(data: any): Promise<any>;

    // ExecutionMatch operations
    findExecutionMatch(executionId: string): Promise<any>;
    upsertExecutionMatch(data: any): Promise<any>;

    // UserGuideState operations
    findUserGuideState(user: string): Promise<any>;
    upsertUserGuideState(user: string, data: any): Promise<any>;
    updateUserGuideState(user: string, data: any): Promise<any>;

    // Raw access if needed (use sparingly)
    getClient(): ExtendedPrismaClient;
}

class PrismaAdapter implements DatabaseAdapter {
    private client: ExtendedPrismaClient;

    constructor(client: ExtendedPrismaClient) {
        this.client = client;
    }

    getClient() {
        return this.client;
    }

    async createSession(data: any) {
        return this.client.session.create({ data });
    }

    async updateSession(taskId: string, data: any) {
        if (data.id) {
            return this.client.session.update({ where: { id: data.id }, data });
        }
        return this.client.session.update({ where: { taskId }, data });
    }

    async upsertSession(taskId: string, createData: any, updateData: any) {
        return this.client.session.upsert({
            where: { taskId },
            create: createData,
            update: updateData
        });
    }

    async findSessionByTaskId(taskId: string) {
        return this.client.session.findUnique({ where: { taskId } });
    }

    async findSessions(where: any) {
        return this.client.session.findMany({ where });
    }

    async findUserByApiKey(apiKey: string) {
        return lookupCoreControlUserByKey(apiKey);
    }
    
    async findUserByUsername(username: string) {
        return currentCoreControlUser(username);
    }

    async findUserByExternalAccount(externalAccount: string) {
        return this.client.user.findUnique({ where: { externalAccount } });
    }

    async updateUserExternalAccount(username: string, externalAccount: string) {
        return this.client.user.update({
            where: { username },
            data: { externalAccount },
        });
    }

    async createUser(data: any) {
        return this.client.user.create({ data });
    }

    async findSkill(name: string, user: string | null) {
        return this.client.skill.findFirst({where:{user,name:{equals:name,mode:"insensitive"}} as any,include:{versions:{orderBy:{version:"desc"}}}});
    }

    async findSkillById(id: string) {
        return this.client.skill.findUnique({ 
            where: { id },
            include: {
                versions: {
                    orderBy: { version: 'desc' }
                }
            }
        });
    }

    async createSkill(data: any) {
        return this.client.skill.create({ data });
    }

    async updateSkill(id: string, data: any) {
        return this.client.skill.update({ where: { id }, data });
    }

    async deleteSkill(id: string) {
        return this.client.skill.delete({ where: { id } });
    }

    async findSkills(where: any) {
        return this.client.skill.findMany({
            where,
            include: {
                versions: {
                    orderBy: { version: 'desc' }
                }
            }
        });
    }

    async findLatestSkillVersion(skillId: string) {
        return this.client.skillVersion.findFirst({
            where: { skillId },
            orderBy: { version: 'desc' }
        });
    }

    async createSkillVersion(data: any) {
        return this.client.skillVersion.create({ data });
    }

    async findSkillVersion(skillId: string, version: number) {
        return this.client.skillVersion.findFirst({
            where: { skillId, version }
        });
    }

    async findSkillVersionBySemanticVersion(skillId: string, semanticVersion: string) {
        return this.client.skillVersion.findFirst({
            where: { skillId, semanticVersion }
        });
    }

    async deleteSkillVersion(skillId: string, version: number) {
        return this.client.skillVersion.deleteMany({
            where: { skillId, version }
        });
    }
    
    async findConfigs(where: any) {
        return this.client.config.findMany({
            where,
            orderBy: { id: 'desc' }
        });
    }

    async findConfigById(id: string) {
        return this.client.config.findUnique({ where: { id } });
    }

    async createConfig(data: any) {
        return this.client.config.create({ data });
    }

    async updateConfig(id: string, data: any) {
        return this.client.config.update({ where: { id }, data });
    }

    async findExecutionById(id: string) {
        return this.client.execution.findUnique({ where: { id } });
    }

    async findExecutions(where: any, orderBy?: any, select?: Record<string, boolean>) {
        return this.client.execution.findMany({
            where,
            orderBy,
            ...(select ? { select } : {}),
        });
    }

    async upsertExecution(data: any) {
        return this.client.execution.upsert(data);
    }

    async updateExecution(id: string, data: any) {
        return this.client.execution.update({ where: { id }, data });
    }

    async deleteExecution(id: string) {
        try {
            await this.client.execution.delete({ where: { id } });
            return true;
        } catch {
            return false;
        }
    }

    async deleteExecutions(where: any) {
        const result = await this.client.execution.deleteMany({ where });
        return result.count;
    }

    async findUserSettings(user: string) {
        return this.client.userSettings.findUnique({ where: { user } });
    }

    async upsertUserSettings(user: string, settingsJson: string) {
        return this.client.userSettings.upsert({
            where: { user },
            update: { settingsJson },
            create: { user, settingsJson }
        });
    }

    async findParsedFlow(skillId: string, version: number, user: string | null) {
        return this.client.parsedFlow.findFirst({
            where: { skillId, version, user }
        });
    }

    async upsertParsedFlow(data: any) {
        const { skillId, version, user } = data;
        return this.client.parsedFlow.upsert({
            where: { skillId_version_user: { skillId, version, user } },
            create: data,
            update: data
        });
    }

    async findExecutionMatch(executionId: string) {
        return this.client.executionMatch.findUnique({
            where: { executionId }
        });
    }

    async upsertExecutionMatch(data: any) {
        const { executionId } = data;
        return this.client.executionMatch.upsert({
            where: { executionId },
            create: data,
            update: data
        });
    }

    async findUserGuideState(user: string) {
        return this.client.userGuideState.findUnique({ where: { user } });
    }

    async upsertUserGuideState(user: string, data: any) {
        return this.client.userGuideState.upsert({
            where: { user },
            update: data,
            create: { user, ...data }
        });
    }

    async updateUserGuideState(user: string, data: any) {
        return this.client.userGuideState.update({ where: { user }, data });
    }
}

export function getDatabaseAdapter(): DatabaseAdapter {
    return new PrismaAdapter(new Proxy({}, {get: (_target, key) => controlClient[key]}) as ExtendedPrismaClient);
}
