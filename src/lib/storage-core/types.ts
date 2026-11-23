export type CoreProfile = {
  username: string;
  principal_id: string;
  display_name: string;
  project_id: 'default';
  workspace_id: string;
  workspaces: Array<{ workspace_id: string; name: string; role: string }>;
};
