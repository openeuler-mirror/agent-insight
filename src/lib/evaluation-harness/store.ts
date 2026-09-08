import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { prisma } from '@/lib/storage/prisma';
import { datasetSchema, evaluatorSchema, targetSchema, canonical, hash, redact } from './domain';
export type AssetKind = 'target' | 'dataset' | 'evaluator';
function key() {
  const raw = process.env.EVALUATION_CREDENTIAL_KEY;
  const k = Buffer.from(raw || '', 'base64');
  if (k.length !== 32) throw new Error('请配置 EVALUATION_CREDENTIAL_KEY（32 字节 Base64），再保存私有凭证');
  return k;
}
export function encrypt(value: unknown) {
  const iv = randomBytes(12),
    cipher = createCipheriv('aes-256-gcm', key(), iv),
    data = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), data]).toString('base64');
}
export function decrypt(value: string) {
  const data = Buffer.from(value, 'base64'),
    cipher = createDecipheriv('aes-256-gcm', key(), data.subarray(0, 12));
  cipher.setAuthTag(data.subarray(12, 28));
  return JSON.parse(Buffer.concat([cipher.update(data.subarray(28)), cipher.final()]).toString('utf8'));
}
export async function createAsset(user: string, kind: AssetKind, assetKey: string, name: string, content: unknown) {
  if (!user || !assetKey || assetKey.length > 200 || !name || name.length > 200) throw new Error('对象标识和名称不能为空，且不超过 200 字符');
  const parsed = (kind === 'target' ? targetSchema : kind === 'dataset' ? datasetSchema : evaluatorSchema).parse(content);
  const stored = canonical(redact(parsed));
  return prisma.$transaction(async (tx: any) => {
    const last = await tx.evaluationAssetVersion.findFirst({
      where: {
        user,
        kind,
        assetKey
      },
      orderBy: {
        version: 'desc'
      }
    });
    if (kind === 'dataset' && last?.archived) throw new Error('评测集已删除，请先恢复后再发布新版本');
    return tx.evaluationAssetVersion.create({
      data: {
        user,
        kind,
        assetKey,
        name,
        version: (last?.version || 0) + 1,
        contentJson: stored,
        contentHash: hash(JSON.parse(stored))
      }
    });
  });
}
export async function getAsset(user: string, id: string, kind?: AssetKind) {
  const row = await prisma.evaluationAssetVersion.findFirst({
    where: {
      user,
      id,
      ...(kind ? {
        kind
      } : {})
    }
  });
  if (!row) throw new Error('指定版本不存在或无权访问');
  return {
    ...row,
    content: JSON.parse(row.contentJson)
  };
}
export async function listAssets(user: string) {
  return prisma.evaluationAssetVersion.findMany({
    where: {
      user
    },
    orderBy: [{
      kind: 'asc'
    }, {
      assetKey: 'asc'
    }, {
      version: 'desc'
    }]
  });
}
export async function saveCredential(user: string, name: string, config: {
  apiKey: string;
  baseUrl: string;
  model: string;
}) {
  const url = new URL(config.baseUrl);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('无效模型地址');
  if (!config.apiKey || config.apiKey.length > 4096 || !config.model) throw new Error('模型和 Key 必填');
  return prisma.evaluationCredential.create({
    data: {
      user,
      name: name.slice(0, 200),
      ciphertext: encrypt(config)
    },
    select: {
      id: true,
      name: true,
      createdAt: true
    }
  });
}
export async function credentialConfig(user: string, id: string) {
  const row = await prisma.evaluationCredential.findFirst({
    where: {
      id,
      user
    }
  });
  if (!row) throw new Error('凭证不存在或无权访问');
  return decrypt(row.ciphertext) as {
    apiKey: string;
    baseUrl: string;
    model: string;
  };
}
export async function listCredentials(user: string) {
  return prisma.evaluationCredential.findMany({
    where: {
      user
    },
    select: {
      id: true,
      name: true,
      createdAt: true
    }
  });
}
export async function archiveAsset(user: string, id: string, archived: boolean) {
  const source = await getAsset(user, id);
  await prisma.evaluationAssetVersion.updateMany({
    where: {
      user,
      kind: source.kind,
      assetKey: source.assetKey
    },
    data: {
      archived
    }
  });
  return {
    archived
  };
}
