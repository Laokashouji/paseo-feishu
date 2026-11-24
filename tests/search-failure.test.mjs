import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("服务端搜索和本地补充均失败时返回错误；可用的空兜底仍是空结果", async () => {
  const directory = mkdtempSync(join(tmpdir(), "paseo-feishu-search-failure-"));
  const executable = join(directory, "lark-cli");
  writeFileSync(
    executable,
    `#!/usr/bin/env node
if (process.argv[3] === '+chat-search' || process.env.FEISHU_TEST_SEARCH_FAILURE === 'all') {
  process.stderr.write('temporary failure'); process.exit(1);
}
process.stdout.write(JSON.stringify({data:{chats:[],has_more:false}}));
`,
    { mode: 0o700 },
  );
  const keys = ["FEISHU_LARK_CLI_BIN", "PASEO_FEISHU_DIR", "FEISHU_TEST_SEARCH_FAILURE"];
  const previous = keys.map((key) => process.env[key]);
  process.env.FEISHU_LARK_CLI_BIN = executable;
  process.env.PASEO_FEISHU_DIR = directory;
  try {
    const { handleSearchChats } = await import("../server/feishu.ts");
    process.env.FEISHU_TEST_SEARCH_FAILURE = "all";
    const failed = await handleSearchChats({ query: "示例" });
    assert.match(failed.error, /temporary failure/);
    process.env.FEISHU_TEST_SEARCH_FAILURE = "server";
    const fallback = await handleSearchChats({ query: "示例" });
    assert.equal(fallback.error, undefined);
    assert.equal(fallback.scope, "local");
    assert.deepEqual(fallback.chats, []);
  } finally {
    keys.forEach((key, i) => {
      if (previous[i] === undefined) delete process.env[key];
      else process.env[key] = previous[i];
    });
    rmSync(directory, { recursive: true, force: true });
  }
});
