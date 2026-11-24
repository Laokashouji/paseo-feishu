import assert from "node:assert/strict";
import test from "node:test";
import { QueryClient, QueryObserver, InfiniteQueryObserver } from "@tanstack/react-query";
import { chatsQueryOptions, listQueryDefaults, requireAvailable, uniqueChats } from "../client/queries.ts";

const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
};
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const page = (id, more = false) => ({
  chats: [{ id, name: id, mode: "group" }],
  hasMore: more,
  nextPageToken: more ? "next" : undefined,
});
function observe(t, options, Observer = InfiniteQueryObserver) {
  const client = new QueryClient();
  const observer = new Observer(client, options);
  const unsubscribe = observer.subscribe(() => {});
  t.after(() => {
    unsubscribe();
    client.clear();
  });
  return { client, observer };
}

test("首次加载无旧计数，顶部刷新会话时保留成功列表", async (t) => {
  let pending = deferred(),
    calls = 0;
  const { client, observer } = observe(
    t,
    chatsQueryOptions(
      () => {
        calls++;
        return pending.promise;
      },
      async () => {},
      "",
    ),
  );
  assert.equal(observer.getCurrentResult().isLoading, true);
  assert.equal(observer.getCurrentResult().data, undefined);
  pending.resolve(page("before"));
  await tick();
  pending = deferred();
  const refresh = client.refetchQueries({ type: "active", queryKey: ["feishu"] }, { cancelRefetch: false });
  assert.equal(calls, 2);
  assert.equal(observer.getCurrentResult().isFetching, true);
  assert.equal(observer.getCurrentResult().data.pages[0].chats[0].id, "before");
  pending.resolve(page("after"));
  await refresh;
  assert.equal(observer.getCurrentResult().data.pages[0].chats[0].id, "after");
});

test("连续搜索只展示当前关键词，较慢的旧响应不能覆盖新结果", async (t) => {
  const old = deferred(),
    recent = deferred();
  const list = async () => page("browse");
  const search = ({ query }) => (query === "old" ? old.promise : recent.promise);
  const { observer } = observe(t, chatsQueryOptions(list, search, "old"));
  observer.setOptions(chatsQueryOptions(list, search, "recent"));
  assert.equal(observer.getCurrentResult().data, undefined);
  recent.resolve({ chats: page("recent").chats, scope: "server" });
  await tick();
  old.resolve({ chats: page("old").chats, scope: "local" });
  await tick();
  assert.equal(observer.getCurrentResult().data.pages[0].chats[0].id, "recent");
  assert.equal(observer.getCurrentResult().hasNextPage, false);
});

test("搜索未返回时清空，旧搜索不能覆盖恢复的浏览列表", async (t) => {
  const pending = deferred();
  const list = async () => page("browse", true),
    search = () => pending.promise;
  const { observer } = observe(t, chatsQueryOptions(list, search, "pending"));
  observer.setOptions(chatsQueryOptions(list, search, ""));
  await tick();
  pending.resolve({ chats: page("late").chats, scope: "server" });
  await tick();
  assert.equal(observer.getCurrentResult().data.pages[0].chats[0].id, "browse");
  assert.equal(observer.getCurrentResult().hasNextPage, true);
});

test("翻页防止重复请求，失败保留前页，重试按 ID 去重", async (t) => {
  let next = deferred(),
    calls = 0;
  const { observer } = observe(
    t,
    chatsQueryOptions(
      async ({ pageToken }) => {
        calls++;
        return pageToken ? next.promise : page("first", true);
      },
      async () => {},
      "",
    ),
  );
  await tick();
  const a = observer.fetchNextPage({ cancelRefetch: false });
  const b = observer.fetchNextPage({ cancelRefetch: false });
  assert.equal(calls, 2);
  next.reject(new Error("timeout"));
  await Promise.all([a, b]);
  assert.equal(observer.getCurrentResult().isFetchNextPageError, true);
  assert.equal(observer.getCurrentResult().data.pages.length, 1);
  next = deferred();
  const retry = observer.fetchNextPage({ cancelRefetch: false });
  next.resolve({ chats: [...page("first").chats, ...page("second").chats], hasMore: false });
  await retry;
  assert.deepEqual(
    uniqueChats(observer.getCurrentResult().data.pages).map((c) => c.id),
    ["first", "second"],
  );
});

test("待办、日程的失败回执进入错误态，刷新失败保留上次成功内容", async (t) => {
  let result = { available: true, tasks: [{ id: "first" }] };
  const { observer } = observe(
    t,
    {
      ...listQueryDefaults,
      queryKey: ["feishu", "tasks"],
      queryFn: async () => requireAvailable(result),
    },
    QueryObserver,
  );
  await tick();
  result = { available: false, error: "服务暂不可用", tasks: [] };
  await observer.refetch();
  assert.equal(observer.getCurrentResult().isError, true);
  assert.equal(observer.getCurrentResult().error.message, "服务暂不可用");
  assert.equal(observer.getCurrentResult().data.tasks[0].id, "first");
  result = { available: true, tasks: [] };
  await observer.refetch();
  assert.equal(observer.getCurrentResult().isSuccess, true);
  assert.deepEqual(observer.getCurrentResult().data.tasks, []);
});

test("搜索错误不冒充空结果，重进列表复用内容并重新读取", async (t) => {
  let calls = 0;
  const client = new QueryClient();
  const options = chatsQueryOptions(
    async () => {
      calls++;
      return page("fresh");
    },
    async () => ({ chats: [], scope: "local", error: "无法连接" }),
    "bad",
  );
  const observer = new InfiniteQueryObserver(client, options);
  let unsubscribe = observer.subscribe(() => {});
  t.after(() => {
    unsubscribe();
    client.clear();
  });
  await tick();
  assert.equal(observer.getCurrentResult().isError, true);
  assert.equal(observer.getCurrentResult().data, undefined);
  unsubscribe();
  client.clear();
  const listOptions = chatsQueryOptions(
    async () => {
      calls++;
      return page("fresh");
    },
    async () => {},
    "",
  );
  const first = new InfiniteQueryObserver(client, listOptions);
  unsubscribe = first.subscribe(() => {});
  await tick();
  unsubscribe();
  await tick();
  const second = new InfiniteQueryObserver(client, listOptions);
  assert.equal(second.getCurrentResult().data.pages[0].chats[0].id, "fresh");
  unsubscribe = second.subscribe(() => {});
  assert.equal(second.getCurrentResult().isFetching, true);
  await tick();
  assert.equal(calls, 2);
});
