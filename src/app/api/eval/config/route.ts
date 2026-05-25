import { readConfig } from '@/lib/storage/data-service';
import { normalizeConfigDatasetType } from '@/lib/engine/evaluation/config-dataset';
import { normalizeConfigQuery, normalizeConfigSkillName, normalizeOptionalSkillVersion } from '@/lib/engine/evaluation/config-target';
import { db, prisma } from '@/lib/storage/prisma';
import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';
const AUDIT_CONFIG_MUTATIONS = process.env.AUDIT_CONFIG_MUTATIONS === '1' || process.env.AUDIT_CONFIG_MUTATIONS === 'true';

function normalizeOutcomeKeyActions(configs: any[]) {
  const grouped = new Map<string, any[]>();

  for (const item of configs) {
    if (normalizeConfigDatasetType(item.dataset_type || item.datasetType) !== 'outcome') continue;
    const skill = normalizeConfigSkillName(item.skill);
    if (!skill) continue;
    const version = normalizeOptionalSkillVersion(item.skillVersion);
    const groupKey = `${skill}::${version ?? 'any'}`;
    const items = grouped.get(groupKey) || [];
    items.push(item);
    grouped.set(groupKey, items);
  }

  for (const items of grouped.values()) {
    const canonical = items
      .slice()
      .sort((a, b) => Number(Boolean(normalizeConfigQuery(a.query))) - Number(Boolean(normalizeConfigQuery(b.query))))
      .find(item => Array.isArray(item.key_actions) && item.key_actions.length > 0);

    if (!canonical || !Array.isArray(canonical.key_actions) || canonical.key_actions.length === 0) continue;

    for (const item of items) {
      item.key_actions = canonical.key_actions;
    }
  }

  return configs;
}

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const user = searchParams.get('user');
    const data = await readConfig(user);
    return NextResponse.json(data);
  } catch (error) {
    console.error('Config Load Error:', error);
    return NextResponse.json({ error: 'Failed to load config' }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    const { configs: incomingConfig, user } = await request.json();
    const referer = request.headers.get('referer') || 'unknown';
    const userAgent = request.headers.get('user-agent') || 'unknown';
    
    if (!Array.isArray(incomingConfig)) {
       return NextResponse.json({ error: 'Invalid config format, expected array' }, { status: 400 });
    }

    const newConfig = normalizeOutcomeKeyActions(incomingConfig);

    if (!user) {
        return NextResponse.json({ error: 'User is required for scoped config' }, { status: 400 });
    }

    const client = db.getClient();
    
    if ('query' in client) {
        const pgClient = client as any;
        
        await pgClient.query('BEGIN');
        try {
            if (AUDIT_CONFIG_MUTATIONS) {
                console.warn(`[Config-Audit] POST /api/config start user=${user} incoming_count=${newConfig.length} referer=${referer} ua=${userAgent}`);
            }
            await pgClient.query(
                `DELETE FROM "Config" WHERE "user" = $1 OR "user" IS NULL`,
                [user]
            );
            if (AUDIT_CONFIG_MUTATIONS) {
                console.warn(`[Config-Audit] deleted scoped configs for user=${user} (including user IS NULL)`);
            }
            
            for (const item of newConfig) {
                const id = require('uuid').v4();
                const datasetType = normalizeConfigDatasetType(item.dataset_type || item.datasetType);
                const normalizedQuery = normalizeConfigQuery(item.query);
                await pgClient.query(
                    `INSERT INTO "Config" (id, query, skill, "skillVersion", "datasetType", "routingIntent", "routingAnchors", "expectedSkills", "standardAnswer", "rootCauses", "keyActions", "user", "parseStatus") VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
                    [
                        id,
                        normalizedQuery,
                        normalizeConfigSkillName(item.skill),
                        normalizeOptionalSkillVersion(item.skillVersion),
                        datasetType,
                        item.routing_intent || null,
                        item.routing_anchors ? JSON.stringify(item.routing_anchors) : null,
                        item.expectedSkills ? JSON.stringify(item.expectedSkills) : (item.skills ? JSON.stringify(item.skills) : null),
                        item.standard_answer || '',
                        item.root_causes ? JSON.stringify(item.root_causes) : null,
                        item.key_actions ? JSON.stringify(item.key_actions) : null,
                        user,
                        item.parse_status || 'completed'
                    ]
                );
            }
            
            await pgClient.query('COMMIT');
            if (AUDIT_CONFIG_MUTATIONS) {
                console.warn(`[Config-Audit] POST /api/config committed user=${user} inserted_count=${newConfig.length}`);
            }
        } catch (e) {
            await pgClient.query('ROLLBACK');
            throw e;
        }
    } else {
        await (prisma as any).$transaction(async (tx: any) => {
            if (AUDIT_CONFIG_MUTATIONS) {
                console.warn(`[Config-Audit] POST /api/config start user=${user} incoming_count=${newConfig.length} referer=${referer} ua=${userAgent}`);
            }
            await tx.config.deleteMany({ 
                where: { 
                    OR: [
                        { user: user },
                        { user: null }
                    ]
                }
            });
            if (AUDIT_CONFIG_MUTATIONS) {
                console.warn(`[Config-Audit] deleted scoped configs for user=${user} (including user IS NULL)`);
            }
            
            for (const item of newConfig) {
                 const datasetType = normalizeConfigDatasetType(item.dataset_type || item.datasetType);
                 const data: any = {
                     query: normalizeConfigQuery(item.query),
                     skill: normalizeConfigSkillName(item.skill),
                     skillVersion: normalizeOptionalSkillVersion(item.skillVersion),
                     datasetType,
                     routingIntent: item.routing_intent || null,
                     routingAnchors: item.routing_anchors ? JSON.stringify(item.routing_anchors) : null,
                     expectedSkills: item.expectedSkills ? JSON.stringify(item.expectedSkills) : (item.skills ? JSON.stringify(item.skills) : null),
                     standardAnswer: item.standard_answer || '',
                     rootCauses: item.root_causes ? JSON.stringify(item.root_causes) : null,
                     keyActions: item.key_actions ? JSON.stringify(item.key_actions) : null,
                     user: user,
                     parseStatus: item.parse_status || 'completed'
                 };
                 await tx.config.create({ data });
            }
            if (AUDIT_CONFIG_MUTATIONS) {
                console.warn(`[Config-Audit] POST /api/config committed user=${user} inserted_count=${newConfig.length}`);
            }
        });
    }

    return NextResponse.json({ success: true, message: 'Config saved' });
  } catch (error) {
    console.error('Config Save Error:', error);
    return NextResponse.json({ error: 'Failed to save config' }, { status: 500 });
  }
}
