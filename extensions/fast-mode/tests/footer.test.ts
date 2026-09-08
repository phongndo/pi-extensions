import assert from "node:assert/strict";
import test from "node:test";
import { formatFastFooterStatus } from "../footer.ts";
import { CodexCapabilities } from "../capabilities.ts";
import { model } from "./helpers.ts";

test("native footer labels stay minimal without implying unsupported Fast is active", () => {
  const capabilities = new CodexCapabilities();
  const supported = capabilities.resolve(model());
  assert.equal(formatFastFooterStatus({ enabled: true }, supported), "speed fast");
  assert.equal(formatFastFooterStatus({ enabled: false }, supported), undefined);
  assert.equal(formatFastFooterStatus({ enabled: undefined }, supported), "speed ?");
  assert.equal(formatFastFooterStatus({ error: "bad state" }, supported), "speed !");
  assert.equal(
    formatFastFooterStatus({ enabled: true }, capabilities.resolve(model("gpt-future"))),
    "speed ?",
  );
  assert.equal(
    formatFastFooterStatus({ enabled: true }, capabilities.resolve(model("gpt-5.4-mini"))),
    "speed unavailable",
  );
});
