import AdmZip from 'adm-zip';
import fs from 'fs';
import path from 'path';
import { db } from '@/lib/storage/prisma';
import { EnterpriseSkill, EnterpriseSkillListResponse, EnterpriseDownloadResponse, SyncResult, SkillSyncResult, EnterpriseDeleteResponse, EnterpriseSkillInfoResponse } from '@/lib/engine/skill-generation/legacy/skill-sync-types';

async function fetchEnterpriseSkillList(cookie?: string): Promise<EnterpriseSkill[]> {
  const listUrl = process.env.ORG_SKILL_LIST_URL;
  console.log('[Enterprise-Sync] 开始获取企业技能清单');
  console.log('[Enterprise-Sync] ORG_SKILL_LIST_URL:', listUrl);

  if (!listUrl) {
    throw new Error('ORG_SKILL_LIST_URL 环境变量未配置');
  }

  console.log('[Enterprise-Sync] 发起请求到:', listUrl);
  console.log('[Enterprise-Sync] Cookie:', cookie ? '存在' : '不存在');

  const response = await fetch(listUrl, {
    headers: {
      'Accept': '*/*',
      ...(cookie ? { Cookie: cookie } : {})
    }
  });

  console.log('[Enterprise-Sync] 响应状态:', response.status, response.statusText);

  const data: EnterpriseSkillListResponse = await response.json();
  console.log('[Enterprise-Sync] 响应数据:', JSON.stringify(data, null, 2));

  if (data.code !== 200) {
    throw new Error(`获取企业技能清单失败: ${data.message}`);
  }

  console.log('[Enterprise-Sync] 成功获取技能清单，数量:', data.data.length);
  return data.data;
}

async function fetchSkillDownloadUrl(skillId: number, cookie?: string): Promise<string> {
  const downloadUrlTemplate = process.env.ORG_SKILL_DOWNLOAD_URL;
  console.log('[Enterprise-Sync] 获取技能下载地址, skillId:', skillId);

  if (!downloadUrlTemplate) {
    throw new Error('ORG_SKILL_DOWNLOAD_URL 环境变量未配置');
  }

  const downloadUrl = downloadUrlTemplate.replace('{id}', skillId.toString());
  console.log('[Enterprise-Sync] 下载URL:', downloadUrl);
  console.log('[Enterprise-Sync] Cookie:', cookie ? '存在' : '不存在');

  const response = await fetch(downloadUrl, {
    headers: {
      'Accept': '*/*',
      ...(cookie ? { Cookie: cookie } : {})
    }
  });

  console.log('[Enterprise-Sync] 下载地址响应状态:', response.status, response.statusText);
  const data: EnterpriseDownloadResponse = await response.json();
  console.log('[Enterprise-Sync] 下载地址响应:', JSON.stringify(data, null, 2));

  if (data.code !== 200) {
    throw new Error(`获取技能下载地址失败: ${data.message}`);
  }

  return data.data.downloadUrl;
}

async function downloadSkillZip(downloadUrl: string): Promise<Buffer> {
  console.log('[Enterprise-Sync] 开始下载技能包:', downloadUrl);
  const response = await fetch(downloadUrl);
  console.log('[Enterprise-Sync] 下载响应状态:', response.status, response.statusText);

  if (!response.ok) {
    throw new Error(`下载技能包失败: ${response.statusText}`);
  }

  const arrayBuffer = await response.arrayBuffer();
  console.log('[Enterprise-Sync] 下载完成，大小:', arrayBuffer.byteLength, 'bytes');
  return Buffer.from(arrayBuffer);
}

function extractSkillZip(zipBuffer: Buffer): Map<string, Buffer> {
  console.log('[Enterprise-Sync] 开始解压技能包');
  const zip = new AdmZip(zipBuffer);
  const entries = zip.getEntries();
  const files = new Map<string, Buffer>();

  console.log('[Enterprise-Sync] ZIP包中的文件数量:', entries.length);
  for (const entry of entries) {
    if (!entry.isDirectory) {
      files.set(entry.entryName, entry.getData());
    }
  }

  console.log('[Enterprise-Sync] 解压完成，文件数量:', files.size);
  return files;
}

async function deleteSkillVersionBySemanticVersion(
  skillName: string,
  semanticVersion: string,
  user: string | null
): Promise<void> {
  console.log('[Enterprise-Sync] 检查是否需要删除本地版本:', skillName, 'v' + semanticVersion, 'user:', user);
  const skill = await db.findSkill(skillName, user);
  if (!skill) {
    console.log('[Enterprise-Sync] 本地不存在同名技能:', skillName);
    return;
  }

  console.log('[Enterprise-Sync] 找到本地技能:', skill.id, skill.name);
  const versionToDelete = await db.findSkillVersionBySemanticVersion(
    skill.id,
    semanticVersion
  );

  if (versionToDelete) {
    console.log('[Enterprise-Sync] 删除本地版本:', versionToDelete.version, 'semanticVersion:', semanticVersion);
    await db.deleteSkillVersion(skill.id, versionToDelete.version);
    console.log('[Enterprise-Sync] 删除完成');
  } else {
    console.log('[Enterprise-Sync] 本地不存在相同语义化版本，无需删除');
  }
}

async function storeSkillFromExtracted(
  extractedFiles: Map<string, Buffer>,
  skillInfo: EnterpriseSkill,
  user: string | null
): Promise<void> {
  console.log('[Enterprise-Sync] 开始存储技能:', skillInfo.name, 'version:', skillInfo.version);
  let skill = await db.findSkill(skillInfo.name, user);

  if (!skill) {
    console.log('[Enterprise-Sync] 创建新技能:', skillInfo.name);
    skill = await db.createSkill({
      name: skillInfo.name,
      description: skillInfo.description,
      visibility: 'private',
      activeVersion: 0,
      user: user
    });
    console.log('[Enterprise-Sync] 新技能创建完成，ID:', skill.id);
  } else {
    console.log('[Enterprise-Sync] 使用现有技能:', skill.id, skill.name);
  }

  const lastVersion = await db.findLatestSkillVersion(skill.id);
  const nextVersionNum = lastVersion ? (lastVersion.version + 1) : 0;
  console.log('[Enterprise-Sync] 下一个整数版本号:', nextVersionNum);

  const storageBase = path.join(process.cwd(), 'data', 'storage', 'skills', skill.id, `v${nextVersionNum}`);
  console.log('[Enterprise-Sync] 存储路径:', storageBase);
  fs.mkdirSync(storageBase, { recursive: true });

  let skillContent = '';
  let fileList: string[] = [];

  console.log('[Enterprise-Sync] 开始保存文件，总数:', extractedFiles.size);
  for (const [filePath, buffer] of extractedFiles) {
    if (filePath.endsWith('SKILL.md')) {
      skillContent = buffer.toString('utf-8');
      console.log('[Enterprise-Sync] 找到SKILL.md文件');
    }

    const fullPath = path.join(storageBase, filePath);
    const dirPath = path.dirname(fullPath);
    fs.mkdirSync(dirPath, { recursive: true });
    fs.writeFileSync(fullPath, buffer);
    fileList.push(filePath);
  }
  console.log('[Enterprise-Sync] 文件保存完成，数量:', fileList.length);

  if (!skillContent) {
    throw new Error('技能包中缺少SKILL.md文件');
  }

  console.log('[Enterprise-Sync] 创建技能版本记录');
  await db.createSkillVersion({
    skillId: skill.id,
    version: nextVersionNum,
    semanticVersion: skillInfo.version,
    enterpriseSkillId: skillInfo.id,
    content: skillContent,
    assetPath: `data/storage/skills/${skill.id}/v${nextVersionNum}`,
    files: JSON.stringify(fileList),
    changeLog: `从企业同步 ${skillInfo.version}`
  });

  console.log('[Enterprise-Sync] 设置激活版本:', nextVersionNum);
  await db.updateSkill(skill.id, { activeVersion: nextVersionNum });
  console.log('[Enterprise-Sync] 技能存储完成');
}

export async function syncEnterpriseSkills(user: string | null, cookie?: string): Promise<SyncResult> {
  console.log('[Enterprise-Sync] ========== 开始企业技能同步 ==========');
  console.log('[Enterprise-Sync] 用户:', user);
  console.log('[Enterprise-Sync] Cookie:', cookie ? '存在' : '不存在');
  const startTime = new Date().toISOString();
  const results: SkillSyncResult[] = [];

  try {
    console.log('[Enterprise-Sync] 步骤1: 获取企业技能清单');
    const enterpriseSkills = await fetchEnterpriseSkillList(cookie);
    console.log('[Enterprise-Sync] 步骤2: 开始处理', enterpriseSkills.length, '个技能');

    for (const skillInfo of enterpriseSkills) {
      console.log('[Enterprise-Sync] --- 开始处理技能:', skillInfo.name, 'v' + skillInfo.version, '---');
      const result: SkillSyncResult = {
        skillName: skillInfo.name,
        skillId: skillInfo.id,
        version: skillInfo.version,
        success: false
      };

      try {
        console.log('[Enterprise-Sync] 步骤3: 检查并删除本地相同版本');
        await deleteSkillVersionBySemanticVersion(skillInfo.name, skillInfo.version, user);

        console.log('[Enterprise-Sync] 步骤4: 获取下载地址');
        const downloadUrl = await fetchSkillDownloadUrl(skillInfo.id, cookie);

        console.log('[Enterprise-Sync] 步骤5: 下载技能包');
        const zipBuffer = await downloadSkillZip(downloadUrl);

        console.log('[Enterprise-Sync] 步骤6: 解压技能包');
        const extractedFiles = extractSkillZip(zipBuffer);

        console.log('[Enterprise-Sync] 步骤7: 存储技能到数据库');
        await storeSkillFromExtracted(extractedFiles, skillInfo, user);

        result.success = true;
        console.log('[Enterprise-Sync] --- 技能处理成功:', skillInfo.name, '---');
      } catch (error: any) {
        result.error = error.message;
        console.error('[Enterprise-Sync] --- 技能处理失败:', skillInfo.name, '---');
        console.error('[Enterprise-Sync] 错误信息:', error.message);
        console.error('[Enterprise-Sync] 错误堆栈:', error.stack);
      }

      results.push(result);
    }

    const endTime = new Date().toISOString();
    const successCount = results.filter(r => r.success).length;
    const failedCount = results.length - successCount;

    console.log('[Enterprise-Sync] ========== 同步完成 ==========');
    console.log('[Enterprise-Sync] 总技能数:', enterpriseSkills.length);
    console.log('[Enterprise-Sync] 成功:', successCount);
    console.log('[Enterprise-Sync] 失败:', failedCount);
    console.log('[Enterprise-Sync] 开始时间:', startTime);
    console.log('[Enterprise-Sync] 结束时间:', endTime);

    return {
      success: failedCount === 0,
      totalSkills: enterpriseSkills.length,
      successCount,
      failedCount,
      results,
      startTime,
      endTime
    };

  } catch (error: any) {
    console.error('[Enterprise-Sync] ========== 同步过程发生异常 ==========');
    console.error('[Enterprise-Sync] 错误信息:', error.message);
    console.error('[Enterprise-Sync] 错误堆栈:', error.stack);
    return {
      success: false,
      totalSkills: 0,
      successCount: 0,
      failedCount: 0,
      results,
      startTime,
      endTime: new Date().toISOString()
    };
  }
}

export async function deleteEnterpriseSkill(
  enterpriseSkillId: number,
  cookie?: string
): Promise<void> {
  const deleteUrlBase = process.env.ORG_SKILL_DELETE_URL_BASE;
  if (!deleteUrlBase) {
    throw new Error('ORG_SKILL_DELETE_URL_BASE 环境变量未配置');
  }

  // 处理URL模板中的{id}占位符
  const deleteUrl = deleteUrlBase.replace('{id}', enterpriseSkillId.toString());

  console.log('[Enterprise-Delete] 删除企业skill:', enterpriseSkillId);
  console.log('[Enterprise-Delete] 删除URL:', deleteUrl);
  console.log('[Enterprise-Delete] Cookie:', cookie ? '存在' : '不存在');

  const response = await fetch(deleteUrl, {
    method: 'DELETE',
    headers: {
      'Accept': '*/*',
      ...(cookie ? { Cookie: cookie } : {})
    }
  });

  console.log('[Enterprise-Delete] 响应状态:', response.status, response.statusText);

  if (!response.ok) {
    throw new Error(`删除企业skill失败: ${response.statusText}`);
  }

  console.log('[Enterprise-Delete] 企业skill删除成功');
}

export async function fetchEnterpriseSkillInfo(
  enterpriseSkillId: number,
  cookie?: string
): Promise<string> {
  const infoUrlBase = process.env.ORG_SKILL_INFO_URL;
  if (!infoUrlBase) {
    throw new Error('ORG_SKILL_INFO_URL 环境变量未配置');
  }

  const infoUrl = infoUrlBase.replace('{id}', enterpriseSkillId.toString());
  console.log('[Enterprise-Info] 查询企业skill信息:', enterpriseSkillId);
  console.log('[Enterprise-Info] 查询URL:', infoUrl);
  console.log('[Enterprise-Info] Cookie:', cookie ? '存在' : '不存在');

  const response = await fetch(infoUrl, {
    method: 'GET',
    headers: {
      'Accept': '*/*',
      ...(cookie ? { Cookie: cookie } : {})
    }
  });

  console.log('[Enterprise-Info] 响应状态:', response.status, response.statusText);

  const data: EnterpriseSkillInfoResponse = await response.json();
  console.log('[Enterprise-Info] 响应数据:', JSON.stringify(data, null, 2));
  console.log('[Enterprise-Info] 企业skill版本:', data.data.version);

  if (data.code !== 200) {
    throw new Error(`查询企业skill信息失败: ${data.message}`);
  }

  return data.data.version;
}