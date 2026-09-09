import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { stripVTControlCharacters } from "node:util";
import { InMemoryCredentialStore, type Credential, type Provider } from "@earendil-works/pi-ai";
import {
  initTheme,
  InteractiveMode,
  ModelRegistry,
  ModelRuntime,
  OAuthSelectorComponent,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
  accountLoginProvider,
  loginId,
  nativeAccounts,
  type NativeAccount,
} from "../../../src/account-identity.ts";
import { installNativeLogin } from "../native-login.ts";
import { credentialEmail, sameAccount } from "../identity.ts";
const jwt = (payload: unknown) =>
  `header.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.signature`;
function credential(
  id: string,
  email = `${id}@example.test`,
  revision = 1,
): Extract<Credential, { type: "oauth" }> {
  return {
    type: "oauth",
    accountId: id,
    access: jwt({
      "https://api.openai.com/auth": { chatgpt_account_id: id, chatgpt_user_id: "user" },
      "https://api.openai.com/profile": { email },
      revision,
    }),
    refresh: `refresh-${id}-${revision}`,
    expires: Date.now() + 3600000,
  };
}
type LoginOption = ConstructorParameters<typeof OAuthSelectorComponent>[1][number];
type NativeMode = {
  session: { modelRuntime: ModelRuntime };
  getLoginProviderOptions(type?: "oauth" | "api_key"): LoginOption[];
  getLogoutProviderOptions(): Promise<LoginOption[]>;
};
async function harness(directory: string, credentials = new InMemoryCredentialStore()) {
  const runtime = await ModelRuntime.create({
    credentials,
    modelsPath: null,
    refreshOnCreate: false,
  });
  let next: Credential = credential("one");
  let flow: (() => Promise<Credential>) | undefined;
  const original = runtime.getProvider("openai-codex")!;
  const base: Provider = {
    ...original,
    auth: {
      oauth: {
        ...original.auth.oauth!,
        login: async () => (flow ? await flow() : next) as Extract<Credential, { type: "oauth" }>,
      },
    },
  };
  runtime.registerNativeProvider(base);
  let accounts: NativeAccount[] = [];
  const changed = async () => {
    accounts = nativeAccounts([base], await credentials.list());
    for (const a of accounts)
      if (a.credentialId !== base.id)
        runtime.registerNativeProvider(accountLoginProvider(base, a.credentialId, a.name));
  };
  await changed();
  const ctx = {
    modelRegistry: new ModelRegistry(runtime),
    ui: { theme: { fg: (_color: string, text: string) => text } },
  } as unknown as ExtensionContext;
  const close = installNativeLogin(ctx, {
    accounts: () => accounts,
    changed,
    lockPath: join(directory, "router-login"),
  });
  const mode = Object.create(InteractiveMode.prototype) as NativeMode;
  Object.defineProperty(mode, "session", { value: { modelRuntime: runtime } });
  const notices: string[] = [];
  const login = (signal?: AbortSignal) =>
    runtime.login(base.id, "oauth", {
      signal,
      prompt: async () => "",
      notify: (event) => {
        if (event.type === "info") notices.push(event.message);
      },
    });
  return {
    runtime,
    mode,
    credentials,
    close,
    login,
    notices,
    changed,
    alias: (id: string, alias?: string) => {
      accounts = accounts.map((a) => (a.credentialId === id ? { ...a, alias } : a));
    },
    set: (c: Credential) => {
      next = c;
    },
    setFlow: (f: () => Promise<Credential>) => {
      flow = f;
    },
  };
}

test("real native login selector has one compact provider row; logout shows emails without account numbers", async () => {
  const directory = mkdtempSync(join(tmpdir(), "pi-native-login-"));
  const h = await harness(directory);
  initTheme("dark", false);
  const render = (mode: "login" | "logout", rows: LoginOption[]) =>
    stripVTControlCharacters(
      new OAuthSelectorComponent(
        mode,
        rows,
        () => {},
        () => {},
      )
        .render(120)
        .join("\n"),
    );
  try {
    let rows = h.mode.getLoginProviderOptions("oauth").filter((r) => r.id === "openai-codex");
    expect(render("login", rows)).toContain("OpenAI Codex •");
    await h.login();
    rows = h.mode.getLoginProviderOptions("oauth").filter((r) => r.id.includes("codex"));
    expect(rows).toHaveLength(1);
    expect(render("login", rows)).toContain("OpenAI Codex ✓ 1");
    h.set(credential("two"));
    await h.login();
    rows = h.mode.getLoginProviderOptions("oauth").filter((r) => r.id.includes("codex"));
    expect(rows).toHaveLength(1);
    const loginUI = render("login", rows);
    expect(loginUI).toContain("OpenAI Codex ✓ 2");
    for (const text of ["stored", "unconfigured", "Add account", "Account 2"])
      expect(loginUI).not.toContain(text);
    const logout = await h.mode.getLogoutProviderOptions();
    expect(logout.map((r) => r.name)).toEqual([
      "OpenAI Codex · one@example.test",
      "OpenAI Codex · two@example.test",
    ]);
    expect(render("logout", logout)).not.toContain("stored");
    h.alias("openai-codex", "Personal");
    expect((await h.mode.getLogoutProviderOptions()).map((r) => r.name)).toContain(
      "OpenAI Codex · Personal · one@example.test",
    );
    expect(
      render(
        "login",
        h.mode.getLoginProviderOptions("oauth").filter((r) => r.id.includes("codex")),
      ),
    ).toContain("OpenAI Codex ✓ 2");
    h.alias("openai-codex", undefined);
    await h.runtime.logout(loginId("openai-codex", 2));
    await h.changed();
    expect(await h.mode.getLogoutProviderOptions()).toHaveLength(1);
    await h.credentials.modify("openai-codex", async () => ({
      ...credential("one"),
      access: "opaque",
    }));
    expect((await h.mode.getLogoutProviderOptions())[0]?.name).toBe("OpenAI Codex");
    expect(
      render(
        "login",
        h.mode.getLoginProviderOptions("oauth").filter((r) => r.id === "openai-codex"),
      ),
    ).toContain("✓ 1");
  } finally {
    h.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("duplicate OAuth login preserves the original slot, updates rotated credentials, and never creates an extra account", async () => {
  const directory = mkdtempSync(join(tmpdir(), "pi-native-dedupe-"));
  const h = await harness(directory);
  try {
    await h.login();
    const updated = credential("one", "one@example.test", 2);
    h.set(updated);
    await h.login();
    expect(await h.credentials.list()).toHaveLength(1);
    expect(await h.credentials.read("openai-codex")).toEqual(updated);
    expect(h.notices.join("\n")).toContain("No duplicate added");
    h.set(credential("different-workspace", "one@example.test"));
    await h.login();
    expect(await h.credentials.list()).toHaveLength(2); // Same email is not the same subscription/account scope.
    h.set(credential("different-workspace", "one@example.test", 2));
    await h.login();
    expect(await h.credentials.list()).toHaveLength(2);
    expect(await h.credentials.read(loginId("openai-codex", 3))).toBeUndefined();
  } finally {
    h.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("concurrent sessions serialize final identity checks, not browser flows; cleanup does not affect another runtime", async () => {
  const directory = mkdtempSync(join(tmpdir(), "pi-native-concurrent-"));
  const store = new InMemoryCredentialStore();
  const a = await harness(directory, store),
    b = await harness(directory, store);
  try {
    let started = 0;
    let both!: () => void;
    const ready = new Promise<void>((resolve) => {
      both = resolve;
    });
    for (const h of [a, b])
      h.setFlow(async () => {
        if (++started === 2) both();
        await ready;
        return credential("one");
      });
    await Promise.all([a.login(), b.login()]);
    expect(await store.list()).toHaveLength(1);
    a.close();
    a.close();
    b.setFlow(async () => credential("two"));
    await b.login();
    expect(await store.list()).toHaveLength(2);
    expect(
      b.mode.getLoginProviderOptions("oauth").filter((r) => r.id.includes("codex")),
    ).toHaveLength(1);
  } finally {
    a.close();
    b.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("cancellation/shutdown during native authentication never writes a new slot", async () => {
  const directory = mkdtempSync(join(tmpdir(), "pi-native-abort-"));
  const h = await harness(directory);
  try {
    const cancel = new AbortController();
    cancel.abort();
    await expect(h.login(cancel.signal)).rejects.toThrow();
    let finish!: (c: Credential) => void;
    h.setFlow(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const pending = h.login();
    h.close();
    finish(credential("one"));
    await expect(pending).rejects.toThrow();
    expect(await h.credentials.list()).toHaveLength(0);
  } finally {
    h.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("identity matching is conservative and display data cannot inject terminal controls", () => {
  expect(
    sameAccount(
      "test",
      { type: "api_key", key: "same", env: { B: "2", A: "1" } },
      { type: "api_key", key: "same", env: { A: "1", B: "2" } },
    ),
  ).toBe(true);
  expect(
    sameAccount(
      "test",
      { type: "api_key", key: "same", env: { ORG: "1" } },
      { type: "api_key", key: "same", env: { ORG: "2" } },
    ),
  ).toBe(false);
  expect(sameAccount("test", { type: "api_key" }, { type: "api_key" })).toBe(false);
  const opaque = {
    type: "oauth" as const,
    access: "opaque-one",
    refresh: "refresh-one",
    expires: 0,
    email: "same@example.test",
  };
  expect(
    sameAccount("test", opaque, { ...opaque, access: "opaque-two", refresh: "refresh-two" }),
  ).toBe(false);
  expect(sameAccount("test", opaque, { ...opaque, access: "changed" })).toBe(true);
  expect(credentialEmail(credential("one"))).toBe("one@example.test");
  expect(credentialEmail({ ...opaque, email: "evil\u001b[31m@example.test" })).toBeUndefined();
  expect(credentialEmail({ ...opaque, email: undefined })).toBeUndefined();
  const scoped = (tenant: string) => ({
    ...opaque,
    access: jwt({ iss: "https://issuer.test", sub: "user", tid: tenant }),
    refresh: `refresh-${tenant}`,
  });
  expect(sameAccount("test", scoped("one"), scoped("two"))).toBe(false);
});
