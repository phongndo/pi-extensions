import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import lockfile from "proper-lockfile";
import {
  createModels,
  InMemoryCredentialStore,
  type Credential,
  type CredentialStore,
  type Provider,
} from "@earendil-works/pi-ai";
import {
  CredentialSynchronizationError,
  InteractiveMode,
  OAuthSelectorComponent,
  type ExtensionContext,
  type ModelRuntime,
} from "@earendil-works/pi-coding-agent";
import {
  loginId,
  isSubscriptionProvider,
  parseLoginId,
  POOL_PREFIX,
  type NativeAccount,
} from "../../src/account-identity.ts";
import { credentialEmail, sameAccount } from "./identity.ts";

type LoginOption = ConstructorParameters<typeof OAuthSelectorComponent>[1][number];
interface NativeMode {
  session: { modelRuntime: ModelRuntime };
}
interface ModeMethods {
  getLoginProviderOptions(this: NativeMode, authType?: "oauth" | "api_key"): LoginOption[];
  getLogoutProviderOptions(this: NativeMode): Promise<LoginOption[]>;
}
interface SelectorMethods {
  formatStatusIndicator(option: LoginOption): string;
}
interface LoginOptions {
  accounts(): NativeAccount[];
  changed(removedCredentialId?: string): Promise<void>;
  lockPath: string;
}
interface Owner {
  ctx: ExtensionContext;
  options: LoginOptions;
  credentials: CredentialStore;
  signal: AbortSignal;
}
interface RuntimePatch {
  owners: Map<symbol, Owner>;
  original: ModelRuntime["login"];
  wrapper: ModelRuntime["login"];
  originalLogout: ModelRuntime["logout"];
  logoutWrapper: ModelRuntime["logout"];
}
const runtimes = new Map<ModelRuntime, RuntimePatch>();
const labels = new WeakMap<LoginOption, { owner: Owner; count?: number }>();
const modePrototype = InteractiveMode.prototype as unknown as ModeMethods;
const selectorPrototype = OAuthSelectorComponent.prototype as unknown as SelectorMethods;
let undoUI: (() => void) | undefined;
const ownerFor = (runtime: ModelRuntime): Owner | undefined =>
  [...(runtimes.get(runtime)?.owners.values() ?? [])].at(-1);
const hidden = (id: string) => id.startsWith("account-") || id.startsWith(POOL_PREFIX);

/** Pi 0.85.1 has no public auth-selector hook. Keep the guarded, reversible private seam here. */
function patchUI() {
  if (undoUI) return;
  const login = modePrototype.getLoginProviderOptions;
  const logout = modePrototype.getLogoutProviderOptions;
  const status = selectorPrototype.formatStatusIndicator;
  if (typeof login !== "function" || typeof logout !== "function" || typeof status !== "function")
    throw new Error("Router requires a compatible Pi native login UI (tested on 0.85.1).");
  const loginWrapper: ModeMethods["getLoginProviderOptions"] = function (type) {
    const options = login.call(this, type);
    const owner = ownerFor(this.session.modelRuntime);
    if (!owner) return options;
    return options
      .filter((option) => !hidden(option.id))
      .filter((option) => {
        if (type !== "api_key") return true;
        // The transparent route keeps a non-interactive API-key check so Pi accepts a
        // request when only pooled slots remain. It must never appear as a sign-in row.
        const provider = this.session.modelRuntime.getProvider(option.id);
        return !(isSubscriptionProvider(provider) && !provider.auth.apiKey?.login);
      })
      .map((option) => {
        if (
          type === "api_key" ||
          !isSubscriptionProvider(this.session.modelRuntime.getProvider(option.id))
        )
          return option;
        const row = { ...option };
        const count = owner.options.accounts().filter((a) => a.provider === option.id).length;
        labels.set(row, { owner, count });
        return row;
      });
  };
  const logoutWrapper: ModeMethods["getLogoutProviderOptions"] = async function () {
    const options = await logout.call(this);
    const owner = ownerFor(this.session.modelRuntime);
    if (!owner) return options;
    const accounts = owner.options.accounts();
    const rows = await Promise.all(
      options.map(async (option) => {
        const account = accounts.find((a) => a.credentialId === option.id);
        const parsed = parseLoginId(option.id);
        const source = account?.provider ?? parsed?.provider ?? option.id;
        const base = this.session.modelRuntime.getProvider(source);
        const credential = await owner.credentials.read(option.id, { signal: owner.signal });
        const email = credential && credentialEmail(credential);
        const row = {
          ...option,
          name: `${base?.name ?? option.name}${account?.alias ? ` · ${account.alias}` : ""}${email ? ` · ${email}` : ""}`,
        };
        labels.set(row, { owner });
        return row;
      }),
    );
    return rows.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  };
  const statusWrapper: SelectorMethods["formatStatusIndicator"] = function (
    this: SelectorMethods,
    option,
  ) {
    const label = labels.get(option);
    if (!label || label.owner.signal.aborted) return status.call(this, option);
    const theme = label.owner.ctx.ui.theme;
    return label.count === undefined
      ? theme.fg("success", " ✓")
      : label.count
        ? theme.fg("success", ` ✓ ${label.count}`)
        : theme.fg("muted", " •");
  };
  modePrototype.getLoginProviderOptions = loginWrapper;
  modePrototype.getLogoutProviderOptions = logoutWrapper;
  selectorPrototype.formatStatusIndicator = statusWrapper;
  undoUI = () => {
    if (modePrototype.getLoginProviderOptions === loginWrapper)
      modePrototype.getLoginProviderOptions = login;
    if (modePrototype.getLogoutProviderOptions === logoutWrapper)
      modePrototype.getLogoutProviderOptions = logout;
    if (selectorPrototype.formatStatusIndicator === statusWrapper)
      selectorPrototype.formatStatusIndicator = status;
    undoUI = undefined;
  };
}

async function addLogin(
  runtime: ModelRuntime,
  owner: Owner,
  base: Provider,
  type: "oauth" | "api_key",
  interaction: Parameters<ModelRuntime["login"]>[2],
): Promise<Credential> {
  const signal = AbortSignal.any([
    owner.signal,
    ...(interaction.signal ? [interaction.signal] : []),
  ]);
  // The existing native dialog/interaction and provider flow run unchanged. No file write until identity is known.
  const staging = createModels({ credentials: new InMemoryCredentialStore() });
  staging.setProvider(base);
  const candidate = await staging.login(base.id, type, { ...interaction, signal });
  signal.throwIfAborted();
  await mkdir(dirname(owner.options.lockPath), { recursive: true, mode: 0o700 });
  // Serialize only identity comparison/allocation/persistence, never a browser or secret prompt.
  const release = await lockfile.lock(owner.options.lockPath, {
    realpath: false,
    stale: 30_000,
    retries: { retries: 30, minTimeout: 50, maxTimeout: 250 },
  });
  let target = base.id;
  let duplicate = false;
  try {
    signal.throwIfAborted();
    const known = owner.options.accounts();
    const saved = (await owner.credentials.list({ signal })).filter(
      (c) =>
        c.providerId === base.id ||
        parseLoginId(c.providerId)?.provider === base.id ||
        known.some((a) => a.provider === base.id && a.credentialId === c.providerId),
    );
    for (const stored of saved) {
      const credential = await owner.credentials.read(stored.providerId, { signal });
      if (credential && sameAccount(base.id, candidate, credential)) {
        target = stored.providerId;
        duplicate = true;
        break;
      }
    }
    if (!duplicate && saved.some((c) => c.providerId === base.id)) {
      const next = Math.max(1, ...saved.map((c) => parseLoginId(c.providerId)?.number ?? 1)) + 1;
      if (!Number.isSafeInteger(next)) throw new Error("Too many account slots");
      target = loginId(base.id, next);
    }
    signal.throwIfAborted();
    // Native Models.login owns abort-safe locked persistence, under the final (possibly deduplicated) ID.
    // This isolated collection never replaces a live provider or swaps its auth while requests run.
    const delivery = createModels({ credentials: owner.credentials });
    delivery.setProvider({
      ...base,
      id: target,
      auth: {
        ...base.auth,
        oauth: base.auth.oauth
          ? {
              ...base.auth.oauth,
              login: async () => candidate as Extract<Credential, { type: "oauth" }>,
            }
          : undefined,
        apiKey: base.auth.apiKey
          ? {
              ...base.auth.apiKey,
              login: async () => candidate as Extract<Credential, { type: "api_key" }>,
            }
          : undefined,
      },
    });
    await delivery.login(target, type, { ...interaction, signal });
  } finally {
    await release();
  }
  try {
    await owner.options.changed();
    const result = await runtime.refresh({
      providers: [...new Set([base.id, target])],
      allowNetwork: false,
      signal,
    });
    if (result.aborted) signal.throwIfAborted();
    if (result.errors.size) throw new Error("Native model state could not refresh. Use /reload.");
    if (duplicate)
      interaction.notify({
        type: "info",
        message: "Already connected — refreshed the existing account. No duplicate added.",
      });
  } catch (cause) {
    throw new CredentialSynchronizationError(target, "login", candidate, { cause });
  }
  return candidate;
}

/** Attach once per active native runtime; returns idempotent cleanup for reload/shutdown. */
export function installNativeLogin(ctx: ExtensionContext, options: LoginOptions): () => void {
  const runtime = (ctx.modelRegistry as unknown as { runtime?: ModelRuntime }).runtime;
  const credentials = (runtime as unknown as { credentials?: CredentialStore } | undefined)
    ?.credentials;
  if (
    !runtime ||
    [runtime.login, runtime.logout, runtime.refresh, runtime.getProvider].some(
      (fn) => typeof fn !== "function",
    ) ||
    !credentials ||
    [credentials.read, credentials.list, credentials.modify, credentials.delete].some(
      (fn) => typeof fn !== "function",
    )
  )
    throw new Error(
      "Router requires a compatible Pi native credential runtime (tested on 0.85.1).",
    );
  patchUI();
  let patch = runtimes.get(runtime);
  if (!patch) {
    const original = runtime.login;
    const originalLogout = runtime.logout;
    const wrapper: ModelRuntime["login"] = async function (
      this: ModelRuntime,
      id,
      type,
      interaction,
    ) {
      const owner = ownerFor(runtime);
      const source =
        parseLoginId(id)?.provider ??
        owner?.options.accounts().find((a) => a.credentialId === id)?.provider ??
        id;
      const base = runtime.getProvider(source);
      if (
        !owner ||
        !base?.getModels().length ||
        hidden(source) ||
        type !== "oauth" ||
        !isSubscriptionProvider(base)
      )
        return original.call(this, id, type, interaction);
      return addLogin(runtime, owner, base, type, interaction);
    };
    const logoutWrapper: ModelRuntime["logout"] = async function (
      this: ModelRuntime,
      id,
      operation,
    ) {
      await originalLogout.call(this, id, operation);
      const owner = ownerFor(runtime);
      if (owner) {
        try {
          await owner.options.changed(id);
        } catch (cause) {
          throw new CredentialSynchronizationError(id, "logout", undefined, { cause });
        }
      }
    };
    patch = { owners: new Map(), original, wrapper, originalLogout, logoutWrapper };
    runtimes.set(runtime, patch);
    runtime.login = wrapper;
    runtime.logout = logoutWrapper;
  }
  const token = Symbol("router-login");
  const lifetime = new AbortController();
  patch.owners.set(token, { ctx, options, credentials, signal: lifetime.signal });
  let closed = false;
  return () => {
    if (closed) return;
    closed = true;
    lifetime.abort();
    patch!.owners.delete(token);
    if (patch!.owners.size) return;
    if (runtime.login === patch!.wrapper) runtime.login = patch!.original;
    if (runtime.logout === patch!.logoutWrapper) runtime.logout = patch!.originalLogout;
    runtimes.delete(runtime);
    if (!runtimes.size) undoUI?.();
  };
}
