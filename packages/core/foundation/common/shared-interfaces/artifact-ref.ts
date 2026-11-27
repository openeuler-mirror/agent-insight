/** 同一项目内的不可变产物。digest 包含摘要算法和校验值。 */
export interface ArtifactRef {
  readonly projectId: string;
  readonly id: string;
  readonly revision: string;
  readonly digest: string;
  readonly sizeBytes: number;
}
