export interface EnterpriseSkillListResponse {
  code: number;
  message: string;
  data: EnterpriseSkill[];
}

export interface EnterpriseSkill {
  id: number;
  name: string;
  version: string;
  description: string;
  createTime: string;
  updateTime: string;
  creator: string;
  creatorName: string | null;
  displayType: string;
  fileName: string;
  skillType: string;
  status: string;
  tags: string;
  versionDescription: string;
}

export interface EnterpriseDownloadResponse {
  code: number;
  message: string;
  data: {
    downloadUrl: string;
    sha: string;
  };
}

export interface SyncResult {
  success: boolean;
  totalSkills: number;
  successCount: number;
  failedCount: number;
  results: SkillSyncResult[];
  startTime: string;
  endTime: string;
}

export interface SkillSyncResult {
  skillName: string;
  skillId: number;
  version: string;
  success: boolean;
  error?: string;
}

export interface EnterpriseDeleteResponse {
  code: number;
  message: string;
  data?: any;
}

export interface EnterpriseSkillInfoResponse {
  code: number;
  message: string;
  data: {
    id: number;
    name: string;
    version: string;
    description: string;
    createTime: string;
    updateTime: string;
    creator: string;
    creatorName: string | null;
    status: string;
    skillType: string;
    fileName: string;
  };
}