import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("附件会话按免打扰状态排序并保留搜索能力", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "paseo-feishu-muted-search-"));
  const bin = join(dir, "lark-cli");
  const fixturePath = join(dir, "fixture.json");
  const callsPath = join(dir, "calls.jsonl");
  writeFileSync(
    bin,
    `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
const fixture = JSON.parse(fs.readFileSync(${JSON.stringify(fixturePath)}, "utf8"));
fs.appendFileSync(${JSON.stringify(callsPath)}, JSON.stringify(args) + "\\n");
if (args[1] === "+chat-list") {
  if (args.includes("--exclude-muted")) process.exit(2);
  const pageIndex = args.includes("--page-token") ? Number(args[args.indexOf("--page-token") + 1]) : 0;
  if (fixture.failPage === pageIndex) { process.stdout.write(JSON.stringify({ok:false})); process.exit(0); }
  const respond = () => process.stdout.write(JSON.stringify({ ok: true, identity: "user", data: {
    chats: fixture.pages[pageIndex], has_more: pageIndex + 1 < fixture.pages.length,
    page_token: String(pageIndex + 1),
  }}));
  if (pageIndex > 0 && fixture.laterPageGate) {
    const waiting = setInterval(() => {
      if (!fs.existsSync(fixture.laterPageGate)) return;
      clearInterval(waiting);
      respond();
    }, 10);
  } else respond();
} else if (args[1] === "chat.user_setting" && args[2] === "batch_query") {
  const ids = JSON.parse(args[args.indexOf("--data") + 1]).chat_ids;
  if (ids.length > 10 || args[args.indexOf("--as") + 1] !== "user") process.exit(2);
  if (fixture.fail && ids.includes(fixture.fail)) process.exit(1);
  process.stdout.write(JSON.stringify({ ok: fixture.ok !== false, identity: fixture.identity ?? "user", data: {
    items: ids.filter(id => id !== fixture.unknown).reverse().map(id => ({
      chat_id: id, is_muted: fixture.muted.includes(id), is_mute_at_all: true,
    })),
  }}));
} else process.exit(3);
`,
    { mode: 0o700 },
  );

  const previousBin = process.env.FEISHU_LARK_CLI_BIN;
  const previousDir = process.env.PASEO_FEISHU_DIR;
  process.env.FEISHU_LARK_CLI_BIN = bin;
  process.env.PASEO_FEISHU_DIR = dir;
  let now = Date.now();
  t.mock.method(Date, "now", () => now);
  const chat = (id, mode = "group") => ({ chat_id: id, name: `会话 ${id}`, chat_mode: mode });
  const setFixture = (value) => {
    now += 61_000;
    writeFileSync(fixturePath, JSON.stringify(value));
    writeFileSync(callsPath, "");
    writeFileSync(join(dir, "recent-attach.json"), "{}");
  };
  try {
    const { handleSearchFeishu, handleListChats, resetAttachmentCache } = await import("../server/feishu.ts");
    resetAttachmentCache();

    await t.test("首批足够展示时不等待后续慢页，后续关键词仍能搜到尾页", async () => {
      const first = Array.from({ length: 100 }, (_, i) => chat(`oc_first_${i}`));
      const laterPageGate = join(dir, "tail-page-release");
      setFixture({ pages: [first, [chat("oc_tail")]], muted: [], laterPageGate });
      const firstScreen = handleSearchFeishu({ query: "" });
      let deadlockTimer;
      const deadlockDeadline = new Promise((_, reject) => {
        deadlockTimer = setTimeout(() => reject(new Error("尾页尚未放行时首屏未返回")), 10_000);
      });
      let tail;
      try {
        assert.equal((await Promise.race([firstScreen, deadlockDeadline])).items.length, 30);
      } finally {
        clearTimeout(deadlockTimer);
        writeFileSync(laterPageGate, "");
        await firstScreen.catch(() => {});
        tail = await handleSearchFeishu({ query: "oc_tail" });
      }
      assert.deepEqual(
        tail.items.map((i) => i.id),
        ["oc_tail"],
      );
    });

    await t.test("重复打开与并发搜索复用会话页和免打扰请求", async () => {
      setFixture({ pages: [[chat("oc_a"), chat("oc_b")]], muted: ["oc_a"] });
      const results = await Promise.all([handleSearchFeishu({ query: "" }), handleSearchFeishu({ query: "会话" })]);
      assert.deepEqual(
        results[0].items.map((i) => i.id),
        ["oc_b", "oc_a"],
      );
      assert.deepEqual(results[1], results[0]);
      const calls = readFileSync(callsPath, "utf8").trim().split("\n").map(JSON.parse);
      assert.equal(calls.filter((args) => args[1] === "+chat-list").length, 1);
      assert.equal(calls.filter((args) => args[1] === "chat.user_setting").length, 1);
    });

    await t.test("缓存上限为 5 页（500 条），避免无界拉取", async () => {
      const pages = Array.from({ length: 7 }, (_, p) => [chat(`oc_p_${p}`)]);
      setFixture({ pages, muted: [] });
      await handleSearchFeishu({ query: "oc_p" });
      const calls = readFileSync(callsPath, "utf8").trim().split("\n").map(JSON.parse);
      assert.equal(calls.filter((args) => args[1] === "+chat-list").length, 5);
    });

    await t.test("跨页排序先于前 30 条截取，后页非免打扰优先于前页免打扰", async () => {
      const muted = Array.from({ length: 35 }, (_, i) => `oc_muted_${i}`);
      const normal = Array.from({ length: 35 }, (_, i) => `oc_normal_${i}`);
      setFixture({ pages: [muted.map((id) => chat(id)), normal.map((id) => chat(id))], muted });
      const result = await handleSearchFeishu({ query: "" });
      assert.deepEqual(
        result.items.map((item) => item.id),
        normal.slice(0, 30),
      );
      const calls = readFileSync(callsPath, "utf8").trim().split("\n").map(JSON.parse);
      const queriedIds = calls
        .filter((args) => args[1] === "chat.user_setting")
        .flatMap((args) => JSON.parse(args[args.indexOf("--data") + 1]).chat_ids);
      assert.deepEqual(queriedIds.sort(), [...muted, ...normal].sort());
    });

    await t.test("搜索保留免打扰单聊和群聊，同类保持原顺序", async () => {
      setFixture({
        pages: [
          [
            chat("oc_muted_group"),
            chat("oc_normal_group"),
            chat("oc_muted_p2p", "p2p"),
            chat("oc_normal_p2p", "p2p"),
          ],
        ],
        muted: ["oc_muted_group", "oc_muted_p2p"],
      });
      const result = await handleSearchFeishu({ query: "会话" });
      assert.deepEqual(
        result.items.map((item) => item.id),
        ["oc_normal_group", "oc_normal_p2p", "oc_muted_group", "oc_muted_p2p"],
      );
      const exact = await handleSearchFeishu({ query: "OC_MUTED_P2P" });
      assert.deepEqual(
        exact.items.map((item) => item.id),
        ["oc_muted_p2p"],
      );
      assert.match(exact.items[0].text, /--chat-id oc_muted_p2p/);
    });

    await t.test("最近附加过的免打扰会话也排在非免打扰之后", async () => {
      setFixture({ pages: [[chat("oc_normal"), chat("oc_muted")]], muted: ["oc_muted"] });
      writeFileSync(join(dir, "recent-attach.json"), JSON.stringify({ oc_muted: "2026-09-16T10:00:00Z" }));
      assert.deepEqual(
        (await handleSearchFeishu({ query: "" })).items.map((item) => item.id),
        ["oc_normal", "oc_muted"],
      );
      assert.deepEqual(
        (await handleListChats({})).chats.map((item) => item.id),
        ["oc_muted", "oc_normal"],
      );
    });

    await t.test("全部免打扰时仍返回全部匹配项，未知状态不视为免打扰", async () => {
      setFixture({ pages: [[chat("oc_a"), chat("oc_b")]], muted: ["oc_a", "oc_b"] });
      assert.deepEqual(
        (await handleSearchFeishu({ query: "" })).items.map((item) => item.id),
        ["oc_a", "oc_b"],
      );
      setFixture({ pages: [[chat("oc_a"), chat("oc_b")]], muted: ["oc_a", "oc_b"], unknown: "oc_b" });
      assert.deepEqual(
        (await handleSearchFeishu({ query: "" })).items.map((item) => item.id),
        ["oc_b", "oc_a"],
      );
    });

    await t.test("读取失败或返回错误身份时保留原有列表", async () => {
      const ids = Array.from({ length: 55 }, (_, i) => `oc_${i}`);
      for (const failure of [{ fail: "oc_50" }, { ok: false }, { identity: "bot" }]) {
        setFixture({ pages: [ids.map((id) => chat(id))], muted: ids.slice(0, 45), ...failure });
        assert.deepEqual(
          (await handleSearchFeishu({ query: "" })).items.map((item) => item.id),
          ids.slice(0, 30),
        );
      }
    });

    await t.test("普通会话足够填满窗口后停止查询后续状态", async () => {
      const ids = Array.from({ length: 100 }, (_, i) => `oc_${i}`);
      setFixture({ pages: [ids.map((id) => chat(id))], muted: ids.slice(0, 10) });
      assert.deepEqual(
        (await handleSearchFeishu({ query: "" })).items.map((item) => item.id),
        ids.slice(10, 40),
      );
      const calls = readFileSync(callsPath, "utf8").trim().split("\n").map(JSON.parse);
      assert.equal(calls.filter((args) => args[1] === "chat.user_setting").length, 5);
    });

    await t.test("没有匹配会话时不查询免打扰设置", async () => {
      setFixture({ pages: [[chat("oc_a")]], muted: ["oc_a"] });
      assert.deepEqual(await handleSearchFeishu({ query: "无匹配" }), { items: [] });
      const calls = readFileSync(callsPath, "utf8").trim().split("\n").map(JSON.parse);
      assert.equal(calls.some((args) => args[1] === "chat.user_setting"), false);
    });
  } finally {
    if (previousBin === undefined) delete process.env.FEISHU_LARK_CLI_BIN;
    else process.env.FEISHU_LARK_CLI_BIN = previousBin;
    if (previousDir === undefined) delete process.env.PASEO_FEISHU_DIR;
    else process.env.PASEO_FEISHU_DIR = previousDir;
    rmSync(dir, { recursive: true, force: true });
  }
});
