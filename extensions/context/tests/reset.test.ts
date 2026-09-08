import assert from "node:assert/strict";
import test from "node:test";
import { ResetController } from "../reset.ts";

test("requests are consumed once and confirmed rollover permits continuation", () => {
  const reset = new ResetController();
  assert.equal(reset.take(), undefined);
  reset.request("checkpoint");
  assert.equal(reset.compacted(), "checkpoint");
  assert.deepEqual(reset.take(), { requestId: "checkpoint", compacted: true });
  assert.equal(reset.take(), undefined);
  assert.equal(reset.compacted(), undefined);
});

test("aborting an older request cannot cancel its replacement", () => {
  const reset = new ResetController();
  const abort = new AbortController();
  reset.request("old", abort.signal);
  reset.request("new");
  abort.abort();
  assert.deepEqual(reset.take(), { requestId: "new", compacted: false });
  reset.request("aborted", abort.signal);
  assert.equal(reset.take(), undefined);
});

test("completion guards reject late callbacks after every invalidating transition", () => {
  for (const invalidate of [
    (reset: ResetController) => reset.cancel(),
    (reset: ResetController) => reset.cancel(true),
    (reset: ResetController) => reset.request("new"),
    (reset: ResetController) => reset.begin(),
  ]) {
    const reset = new ResetController();
    const finish = reset.begin();
    invalidate(reset);
    assert.equal(finish(), false);
    assert.equal(finish(), false);
  }
  const reset = new ResetController();
  const finish = reset.begin();
  assert.equal(finish(), true);
  assert.equal(finish(), false);
});

test("closed lifetimes cannot restart", () => {
  const reset = new ResetController();
  reset.cancel(true);
  reset.cancel();
  reset.request("ignored");
  assert.equal(reset.closed, true);
  assert.equal(reset.take(), undefined);
  assert.equal(reset.begin()(), false);
});
