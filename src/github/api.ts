export const GITHUB_API = "https://api.github.com";

export function githubHeaders(token?: string): HeadersInit {
  return {
    Accept: "application/vnd.github+json",
    "User-Agent": "cfrunner",
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
}
