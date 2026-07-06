// Compile-time configuration. Edit these values and rebuild.
//
// Values here are effectively public (a Chrome extension is shipped
// unminified to end users), so never put secrets in this file. The
// GitHub App Client ID is specifically a public identifier - GitHub's
// own docs call it out.

/**
 * Client ID of the public-facing ProDocStore GitHub App. Public users
 * sign in through this App and get tokens scoped to whatever repos
 * they grant.
 *
 * The Client ID is a public identifier (GitHub's docs call this out
 * explicitly), so committing it here is intentional and safe.
 *
 * Forks pointing at a different App can either edit this constant and
 * rebuild, or leave it empty - users will then paste their own Client
 * ID via the Options page at runtime.
 */
export const DEFAULT_GITHUB_APP_CLIENT_ID = "Iv23lizPBagBsf1wOLk7";
