import type { CredentialInfo, Provider } from "@earendil-works/pi-ai";

export interface NativeAccount {
  id: string;
  name: string;
  /** User-chosen display label; never used as a routing or credential identifier. */
  alias?: string;
  provider: string;
  credentialId: string;
  type: CredentialInfo["type"];
}
export interface LegacyAccount {
  id: string;
  name: string;
  provider: string;
  credentialId: string;
}
export const POOL_PREFIX = "accounts-";
export const poolId = (provider: string) => `${POOL_PREFIX}${provider}`;
export const sourceProvider = (provider: string) =>
  provider.startsWith(POOL_PREFIX) ? provider.slice(POOL_PREFIX.length) : provider;
export const loginId = (provider: string, number: number) => `account--${provider}--${number}`;
export function parseLoginId(id: string): { provider: string; number: number } | undefined {
  const match = /^account--([a-zA-Z0-9._-]+)--([2-9]|[1-9][0-9]+)$/.exec(id);
  if (!match || !Number.isSafeInteger(Number(match[2]))) return;
  return { provider: match[1]!, number: Number(match[2]) };
}

/** Eligibility follows Pi's provider metadata, including future subscription providers. */
export const isSubscriptionProvider = (provider: Provider | undefined): boolean =>
  provider?.auth.oauth?.isSubscription === true;
export const isSubscriptionAccount = (
  account: NativeAccount,
  provider: Provider | undefined,
): boolean => account.type === "oauth" && isSubscriptionProvider(provider);

/** Native credential metadata is the source of truth; ranking files cannot create a login. */
export function nativeAccounts(
  providers: readonly Provider[],
  credentials: readonly CredentialInfo[],
  legacy: LegacyAccount[] = [],
): NativeAccount[] {
  const sources = new Map(
    providers
      .filter(
        (p) =>
          !p.id.startsWith(POOL_PREFIX) && !p.id.startsWith("account-") && p.getModels().length > 0,
      )
      .map((p) => [p.id, p]),
  );
  return credentials
    .flatMap((credential): NativeAccount[] => {
      const alias = parseLoginId(credential.providerId);
      const old = legacy.find((a) => a.credentialId === credential.providerId);
      const provider = sources.get(alias?.provider ?? old?.provider ?? credential.providerId);
      if (!provider || (credential.type === "oauth" ? !provider.auth.oauth : !provider.auth.apiKey))
        return [];
      return [
        {
          id: old?.id ?? (alias ? credential.providerId : `native:${provider.id}`),
          name: old?.name ?? `Account ${alias?.number ?? 1}`,
          provider: provider.id,
          credentialId: credential.providerId,
          type: credential.type,
        },
      ];
    })
    .sort(
      (a, b) =>
        a.provider.localeCompare(b.provider) ||
        (parseLoginId(a.credentialId)?.number ?? 1) - (parseLoginId(b.credentialId)?.number ?? 1) ||
        a.id.localeCompare(b.id),
    );
}

/** Register this like any Pi provider: native /login owns interaction and writes, /logout owns deletion. */
export function accountLoginProvider(base: Provider, id: string, label: string): Provider {
  const apiKey = base.auth.apiKey;
  return {
    ...base,
    id,
    name: `${base.name} · ${label}`,
    getModels: () => [],
    refreshModels: undefined,
    auth: {
      ...base.auth,
      apiKey: apiKey
        ? {
            ...apiKey,
            check: async (input) =>
              input.credential
                ? apiKey.check
                  ? apiKey.check(input)
                  : (await apiKey.resolve(input))
                    ? { type: "api_key" }
                    : undefined
                : undefined,
            resolve: async (input) => (input.credential ? apiKey.resolve(input) : undefined),
          }
        : undefined,
    },
  };
}
