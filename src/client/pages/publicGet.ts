/** One read of a public link's API. No cookies go with it: the token is the only credential. */
export async function publicGet<T>(path: string): Promise<T> {
  const response = await fetch(path, { credentials: "omit", referrerPolicy: "no-referrer" });
  if (!response.ok) throw new Error(String(response.status));
  return (await response.json()) as T;
}
