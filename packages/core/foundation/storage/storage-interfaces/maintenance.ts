/** 只注入受运维授权的部署进程。迁移版本和证据格式由对应后端校验。 */
export interface SchemaState {
  readonly backend: 'sqlite' | 'postgresql' | 'opengauss' | 'clickhouse';
  readonly currentVersion: string | null;
  readonly requiredVersion: string;
}

export interface StorageMaintenance {
  inspect(): Promise<SchemaState>;
  plan(): Promise<readonly { readonly version: string; readonly checksum: string }[]>;
  initializeEmpty(): Promise<SchemaState>;
  migrate(input: { expectedVersion: string; targetVersion: string; backupEvidence: { readonly kind: 'sqlite-backup' | 'verified-manifest'; readonly id: string } }): Promise<SchemaState>;
}
