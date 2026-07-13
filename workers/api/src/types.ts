export type AuthProvider = "github" | "google";

export interface Env {
  PDS_API_KV: KVNamespace;
  DB: D1Database; // platform-native private KB store (see migrations/)
  EDITOR_BASE_URL: string;
  PUBLIC_BASE_URL: string;
  COOKIE_DOMAIN?: string;
  GITHUB_ORG: string;
  GITHUB_CLIENT_ID?: string;
  GITHUB_CLIENT_SECRET?: string;
  GITHUB_TOKEN?: string;
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  PDS_KEY_ENCRYPTION_KEY?: string;
  CLOUDFLARE_API_TOKEN?: string;
  CLOUDFLARE_ACCOUNT_ID?: string;
}

export interface Session {
  id: string;
  user: {
    id: string;
    provider: AuthProvider;
    login: string;
    name: string;
    avatarUrl: string;
    githubUrl: string;
    email?: string;
  };
  githubAccessToken?: string;
  createdAt: string;
  updatedAt: string;
}

export type Variables = {
  session: Session | null;
};
