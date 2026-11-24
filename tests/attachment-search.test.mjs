import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PluginAttachmentSearchPayloadSchema } from "@getpaseo/plugin";
import { searchFeishu } from "../shared/feishu.ts";

test("会话搜索在缺失或无效链接时仍通过宿主附件校验，并按国内飞书 / 海外 Lark 兜底域名", async () => {
  const directory = mkdtempSync(join(tmpdir(), "paseo-feishu-attachment-search-"));
  const executable = join(directory, "lark-cli");
  const originalLink = "https://applink.feishu.cn/client/chat/open?openChatId=oc_valid&extra=kept";
  const chats = [
    { chat_id: "oc_missing", name: "测试单聊", chat_mode: "p2p" },
    { chat_id: "oc_empty", name: "测试群聊", chat_mode: "group", chat_app_link: "" },
    { chat_id: "oc_invalid", name: "测试机器人", chat_mode: "p2p", p2p_target_type: "bot", chat_app_link: "not a URL" },
    { chat_id: "oc_valid", name: "测试有效链接", chat_mode: "group", chat_app_link: originalLink },
    { chat_id: "oc_encoded &?", name: "测试参数编码", chat_mode: "group" },
  ];
  writeFileSync(
    executable,
    `#!/usr/bin/env node
if (process.argv[2] !== "im" || process.argv[3] !== "+chat-list") process.exit(1);
process.stdout.write(${JSON.stringify(JSON.stringify({ data: { chats, has_more: false } }))});
`,
    { mode: 0o700 },
  );

  const keys = ["FEISHU_LARK_CLI_BIN", "PASEO_FEISHU_DIR", "FEISHU_BRAND", "LARKSUITE_CLI_CONFIG_DIR"];
  const previous = keys.map((key) => process.env[key]);
  process.env.FEISHU_LARK_CLI_BIN = executable;
  process.env.PASEO_FEISHU_DIR = directory;
  process.env.LARKSUITE_CLI_CONFIG_DIR = directory;
  delete process.env.FEISHU_BRAND;

  try {
    const { handleSearchFeishu, resetAttachmentCache } = await import("../server/feishu.ts");
    resetAttachmentCache();

    // 默认国内飞书域名
    const result = await handleSearchFeishu({ query: "测试" });
    assert.equal(result.items.length, chats.length);
    assert.equal(PluginAttachmentSearchPayloadSchema.safeParse(result).success, true);
    assert.strictEqual(searchFeishu.output, PluginAttachmentSearchPayloadSchema);
    for (const item of result.items) {
      const url = new URL(item.url);
      assert.equal(url.origin, "https://applink.feishu.cn");
      assert.equal(url.pathname, "/client/chat/open");
      assert.equal(url.searchParams.get("openChatId"), item.id);
      assert.ok(item.text.includes(item.url));
      assert.ok(item.text.includes(`--chat-id ${item.id}`));
    }
    assert.equal(result.items.find((item) => item.id === "oc_valid").url, originalLink);
    assert.deepEqual(
      result.items.slice(0, 3).map((item) => item.title),
      ["[单聊] 测试单聊", "[群聊] 测试群聊", "[机器人] 测试机器人"],
    );
    const oldResult = { items: [{ ...result.items[0], url: "" }] };
    assert.equal(PluginAttachmentSearchPayloadSchema.safeParse(oldResult).success, false);
    assert.equal(searchFeishu.output.safeParse(oldResult).success, false);
    assert.equal((await handleSearchFeishu({ query: "单聊" })).items.length, 1);
    assert.deepEqual(await handleSearchFeishu({ query: "不存在" }), { items: [] });
    assert.equal((await handleSearchFeishu({ query: "" })).items.length, chats.length);

    // 海外 Lark 品牌（通过 lark-cli config.json 识别）
    writeFileSync(join(directory, "config.json"), JSON.stringify({ apps: [{ appId: "cli_1", brand: "lark" }] }));
    resetAttachmentCache();
    const larkResult = await handleSearchFeishu({ query: "测试" });
    assert.equal(new URL(larkResult.items.find((item) => item.id === "oc_missing").url).origin, "https://applink.larksuite.com");
    // 原有合法链接仍完整保留
    assert.equal(larkResult.items.find((item) => item.id === "oc_valid").url, originalLink);
  } finally {
    keys.forEach((key, i) => {
      if (previous[i] === undefined) delete process.env[key];
      else process.env[key] = previous[i];
    });
    rmSync(directory, { recursive: true, force: true });
  }
});
