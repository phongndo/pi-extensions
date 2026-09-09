import type { Credential } from "@earendil-works/pi-ai";

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
function string(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 && value.length <= 2048 ? value : undefined;
}
/** Claims are display/dedup hints from native credentials, never authentication verification. */
function claims(token: unknown): Record<string, unknown> {
  if (typeof token !== "string") return {};
  const payload = token.split(".")[1];
  if (!payload || payload.length > 65536) return {};
  try {
    return object(JSON.parse(Buffer.from(payload, "base64url").toString("utf8")));
  } catch {
    return {};
  }
}
export function credentialEmail(credential: Credential): string | undefined {
  if (credential.type !== "oauth") return;
  const access = claims(credential.access);
  const identity = claims(credential.id_token ?? credential.idToken);
  const candidates = [
    credential.email,
    object(credential.account).email,
    access.email,
    object(access["https://api.openai.com/profile"]).email,
    identity.email,
  ];
  return candidates.find(
    (value): value is string =>
      typeof value === "string" &&
      value.length <= 254 &&
      !/\p{C}/u.test(value) &&
      /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value),
  );
}
function oauthIdentity(provider: string, credential: Credential): string | undefined {
  if (credential.type !== "oauth") return;
  const access = claims(credential.access);
  const auth = object(access["https://api.openai.com/auth"]);
  const account = string(credential.accountId) ?? string(auth.chatgpt_account_id);
  if (provider === "openai-codex" && account) {
    return JSON.stringify([account, string(auth.chatgpt_user_id) ?? string(auth.user_id) ?? null]);
  }
  // Do not collapse different tenants/projects/organizations just because the email matches.
  const scope = [
    credential.tenantId,
    credential.organizationId,
    credential.projectId,
    credential.enterpriseDomain,
    access.tid,
    access.tenant_id,
    access.org_id,
    access.organization_id,
  ].map((value) => string(value) ?? null);
  if (account) return JSON.stringify(["account", account, ...scope]);
  const issuer = string(access.iss),
    subject = string(access.sub);
  return issuer && subject ? JSON.stringify(["subject", issuer, subject, ...scope]) : undefined;
}
export function sameAccount(provider: string, a: Credential, b: Credential): boolean {
  if (a.type !== b.type) return false;
  if (a.type === "api_key" && b.type === "api_key") {
    const env = (credential: typeof a) =>
      Object.entries(credential.env ?? {}).sort(([a], [b]) => a.localeCompare(b));
    if (!a.key && !Object.keys(a.env ?? {}).length) return false;
    return a.key === b.key && JSON.stringify(env(a)) === JSON.stringify(env(b));
  }
  if (a.type !== "oauth" || b.type !== "oauth") return false;
  const left = oauthIdentity(provider, a),
    right = oauthIdentity(provider, b);
  if (left && right) return left === right;
  return (!!a.refresh && a.refresh === b.refresh) || (!!a.access && a.access === b.access);
}
