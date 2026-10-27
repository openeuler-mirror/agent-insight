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