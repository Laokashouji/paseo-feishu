import { infiniteQueryOptions } from "@tanstack/react-query";
import type { RpcInput, RpcOutput } from "@getpaseo/plugin";
import type { listChats, searchChats } from "../shared/feishu";

type ChatPage = RpcOutput<typeof listChats> & { scope?: RpcOutput<typeof searchChats>["scope"] };

// 短暂切页可复用内容，但每次进入都刷新；导航位置查询仍单独保持零缓存。
export const listQueryDefaults = { staleTime: 0, gcTime: 60_000, refetchOnMount: "always", retry: false } as const;

export function requireAvailable<T extends { available: boolean; error?: string }>(result: T): T {
  if (!result.available) throw new Error(result.error || "暂时无法读取，请重试");
  return result;
}

export function chatsQueryOptions(
  list: (input: RpcInput<typeof listChats>) => Promise<RpcOutput<typeof listChats>>,
  search: (input: RpcInput<typeof searchChats>) => Promise<RpcOutput<typeof searchChats>>,
  keyword: string,
) {
  const query = keyword.trim();
  return infiniteQueryOptions({
    ...listQueryDefaults,
    queryKey: ["feishu", "chats", query],
    initialPageParam: undefined as string | undefined,
    queryFn: async ({ pageParam }): Promise<ChatPage> => {
      if (!query) return list({ pageSize: 20, pageToken: pageParam });
      const result = await search({ query });
      if (result.error) throw new Error(result.error);
      return { ...result, hasMore: false };
    },
    getNextPageParam: (page) => (page.hasMore ? page.nextPageToken : undefined),
  });
}

export function uniqueChats(pages: ChatPage[]) {
  const seen = new Set<string>();
  return pages.flatMap((page) => page.chats).filter((chat) => {
    if (seen.has(chat.id)) return false;
    seen.add(chat.id);
    return true;
  });
}
