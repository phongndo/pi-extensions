export interface AccountInfo {
  id: string;
  name: string;
  provider: string;
  enabled: boolean;
  credentialId?: string;
  type?: "oauth" | "api_key";
}
