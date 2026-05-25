import { canAccessSkill, resolveUser } from '@/lib/auth/auth';
import { db } from '@/lib/storage/prisma';
import { NextRequest, NextResponse } from 'next/server';
import { deleteEnterpriseSkill, fetchEnterpriseSkillInfo } from '@/lib/engine/skill-generation/legacy/skill-sync-service';

export async function DELETE(
    request: NextRequest,
    { params }: { params: Promise<{ id: string; version: string }> }
) {
    try {
        const { id, version: versionStr } = await params;
        const version = parseInt(versionStr, 10);

        if (isNaN(version)) {
            return NextResponse.json({ error: 'Invalid version number' }, { status: 400 });
        }

        const { username } = await resolveUser(request);

        const { allowed, skill } = await canAccessSkill(id, username);
        if (!skill) {
            return NextResponse.json({ error: 'Skill not found' }, { status: 404 });
        }
        if (!allowed) {
            return NextResponse.json({ error: 'Unauthorized: You do not own this skill' }, { status: 403 });
        }

        const versionToDelete = await db.findSkillVersion(id, version);
        if (!versionToDelete) {
            return NextResponse.json({ error: `Version ${version} not found` }, { status: 404 });
        }

        if (skill.versions && skill.versions.length === 1) {
            return NextResponse.json({
                error: 'Cannot delete the last version. Delete the skill instead.'
            }, { status: 400 });
        }

        // 企业模式：先删除对应的企业skill（带版本检查）
        if (process.env.ORGANIZATION_MODE === 'true') {
          try {
            const incomingCookie = request.headers.get('cookie') || undefined;
            console.log('[Delete-Version] 企业模式，开始删除企业skill');

            if (versionToDelete.enterpriseSkillId) {
              console.log('[Delete-Version] 检查企业skill ID:', versionToDelete.enterpriseSkillId);

              // 查询企业skill的版本号
              const enterpriseVersion = await fetchEnterpriseSkillInfo(
                versionToDelete.enterpriseSkillId,
                incomingCookie
              );

              // 本地skill的版本号
              const localVersion = versionToDelete.semanticVersion;

              console.log('[Delete-Version] 本地版本:', localVersion, '企业版本:', enterpriseVersion);

              // 版本一致性检查
              if (localVersion === enterpriseVersion) {
                console.log('[Delete-Version] 版本一致，删除企业skill');
                await deleteEnterpriseSkill(versionToDelete.enterpriseSkillId, incomingCookie);
              } else {
                console.log('[Delete-Version] 版本不一致，跳过删除（企业已有新版本）');
              }
            }
          } catch (error: any) {
            console.error('[Delete-Version] 企业删除失败，继续删除本地版本:', error);
            console.error('[Delete-Version] 错误信息:', error.message);
          }
        }

        await db.deleteSkillVersion(id, version);

        if (skill.activeVersion === version) {
            const remainingVersions = (skill.versions || []).filter((v: any) => v.version !== version);
            if (remainingVersions.length > 0) {
                const newActiveVersion = remainingVersions[0].version;
                await db.updateSkill(id, { activeVersion: newActiveVersion });
                console.log(`[Delete Version] Updated activeVersion from ${version} to ${newActiveVersion}`);
            }
        }

        return NextResponse.json({
            success: true,
            message: `Version ${version} deleted successfully`,
            previousActiveVersion: skill.activeVersion
        });

    } catch (error: any) {
        console.error('Delete Version Error:', error);
        return NextResponse.json({ error: error.message }, { status: 500 });
    }
}

export async function GET(
    request: NextRequest,
    { params }: { params: Promise<{ id: string; version: string }> }
) {
    try {
        const { id, version: versionStr } = await params;
        const version = parseInt(versionStr, 10);

        if (isNaN(version)) {
            return NextResponse.json({ error: 'Invalid version number' }, { status: 400 });
        }

        const skillVersion = await db.findSkillVersion(id, version);
        if (!skillVersion) {
            return NextResponse.json({ error: `Version ${version} not found` }, { status: 404 });
        }

        return NextResponse.json(skillVersion);

    } catch (error: any) {
        console.error('Get Version Error:', error);
        return NextResponse.json({ error: error.message }, { status: 500 });
    }
}
