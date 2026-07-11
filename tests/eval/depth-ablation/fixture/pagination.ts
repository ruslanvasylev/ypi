export interface Page<T> { items: T[]; hasMore: boolean; nextCursor?: string }
export type FetchPage<T> = (cursor?: string) => Promise<Page<T>>;

export async function collectAll<T>(fetchPage: FetchPage<T>): Promise<T[]> {
  const result: T[] = [];
  let cursor = "0";
  while (true) {
    const page = await fetchPage(cursor);
    result.push(...page.items);
    if (!page.hasMore) return result;
    cursor = String(Number(cursor) + page.items.length);
  }
}
