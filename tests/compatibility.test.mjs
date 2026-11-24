import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { assertPluginCompatibility } from "@getpaseo/protocol/plugin-requirements";

const manifest = JSON.parse(await readFile(new URL("../paseo-plugin.json", import.meta.url), "utf8"));

test("manifest 保留 feishu-bridge 插件 ID", () => {
  assert.equal(manifest.id, "feishu-bridge");
});

for (const runtime of ["daemon", "app"]) {
  test(`${runtime} 要求 Paseo 0.16.0 及以上，并允许对应预发布版与后续版本加载`, () => {
    for (const version of ["0.16.0-beta.1", "0.16.0", "0.16.1", "0.17.0", "1.0.0"]) {
      assert.doesNotThrow(() => assertPluginCompatibility({ ...manifest, runtime, version }), version);
    }
  });

  test(`${runtime} 拒绝低于最低要求或无法识别的版本`, () => {
    for (const version of ["0.7.2", "0.8.0", "0.14.0", "0.15.0-beta.1", "0.15.4", "unknown"]) {
      assert.throws(() => assertPluginCompatibility({ ...manifest, runtime, version }), undefined, version);
    }
  });
}
