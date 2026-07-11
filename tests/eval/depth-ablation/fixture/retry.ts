export interface RetryResponse { ok: boolean; retryAfter?: string }

export async function requestWithRetry(
  method: string,
  maxAttempts: number,
  request: () => Promise<RetryResponse>,
): Promise<RetryResponse> {
  for (let attempt = 0; attempt <= maxAttempts; attempt++) {
    const response = await request();
    if (response.ok) return response;
    if (response.retryAfter) {
      await new Promise((resolve) => setTimeout(resolve, Number(response.retryAfter)));
    }
    if (!["GET", "PUT", "POST"].includes(method)) return response;
  }
  return { ok: false };
}
