// GitHub's OAuth device flow, run by the hub on an installation's behalf. The hub talks to GitHub;
// the installation only relays a code to its user. GitHub's access token never leaves the hub, and
// the hub drops it once it has read who signed in.

export interface GitHubSignInOptions {
  /** The client id of a GitHub OAuth app with "Enable Device Flow" turned on. No secret is needed. */
  clientId: string;
  /** Accept only members of these organisations (asks GitHub for read:org). */
  allowedOrgs?: string[];
  /** Accept only these GitHub logins. */
  allowedUsers?: string[];
  /** How long a sign-in lasts before it must be renewed. Default 180 days. */
  userTokenTtlSeconds?: number;
  /** For tests. */
  fetch?: typeof fetch;
  /** For GitHub Enterprise Server: e.g. `https://github.example.com` and `https://github.example.com/api/v3`. */
  webUrl?: string;
  apiUrl?: string;
}

export interface DeviceCode {
  device_code: string;
  user_code: string;
  verification_uri: string;
  expires_in: number;
  interval: number;
}

export type DevicePoll =
  | { status: "pending"; interval?: number }
  | { status: "denied" }
  | { status: "expired" }
  | { status: "complete"; accessToken: string };

/** A failure talking to GitHub, or a configuration GitHub refused. */
export class GitHubError extends Error {}

const DEVICE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";

function urls(options: GitHubSignInOptions) {
  return { web: (options.webUrl ?? "https://github.com").replace(/\/+$/, ""), api: (options.apiUrl ?? "https://api.github.com").replace(/\/+$/, "") };
}

async function postForm(options: GitHubSignInOptions, path: string, body: Record<string, string>): Promise<Record<string, unknown>> {
  const response = await (options.fetch ?? fetch)(urls(options).web + path, {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded", "user-agent": "mcp-feedback-hub" },
    body: new URLSearchParams(body).toString(),
    signal: AbortSignal.timeout(10_000),
  });
  if (response.status === 404 && path === "/login/device/code") {
    throw new GitHubError("GitHub does not know this OAuth app's client id. Check MCP_FEEDBACK_GITHUB_CLIENT_ID and that the app has device flow enabled.");
  }
  if (!response.ok) throw new GitHubError(`GitHub answered ${response.status}.`);
  return (await response.json()) as Record<string, unknown>;
}

async function api(options: GitHubSignInOptions, accessToken: string, path: string): Promise<unknown> {
  const response = await (options.fetch ?? fetch)(urls(options).api + path, {
    headers: { accept: "application/vnd.github+json", authorization: `Bearer ${accessToken}`, "user-agent": "mcp-feedback-hub" },
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new GitHubError(`GitHub answered ${response.status} for ${path}.`);
  return response.json();
}

export async function startDeviceFlow(options: GitHubSignInOptions): Promise<DeviceCode> {
  const scope = options.allowedOrgs?.length ? "read:org" : "";
  const body = await postForm(options, "/login/device/code", { client_id: options.clientId, scope });
  if (typeof body.error === "string") throw new GitHubError(`GitHub refused to start a sign-in: ${body.error}. Check that the OAuth app has device flow enabled.`);
  const code = body as unknown as DeviceCode;
  if (typeof code.device_code !== "string" || typeof code.user_code !== "string" || typeof code.verification_uri !== "string") {
    throw new GitHubError("GitHub gave an unexpected answer to the sign-in request.");
  }
  return { ...code, interval: Number(code.interval) || 5, expires_in: Number(code.expires_in) || 900 };
}

export async function pollDeviceFlow(options: GitHubSignInOptions, deviceCode: string): Promise<DevicePoll> {
  const body = await postForm(options, "/login/oauth/access_token", { client_id: options.clientId, device_code: deviceCode, grant_type: DEVICE_GRANT });
  if (typeof body.access_token === "string") return { status: "complete", accessToken: body.access_token };
  switch (body.error) {
    case "authorization_pending":
      return { status: "pending" };
    case "slow_down":
      return { status: "pending", interval: Number(body.interval) || undefined };
    case "access_denied":
      return { status: "denied" };
    case "expired_token":
    case "incorrect_device_code":
    case "token_expired":
      return { status: "expired" };
    default:
      throw new GitHubError(`GitHub refused the sign-in: ${String(body.error ?? "no reason given")}.`);
  }
}

/** Who signed in, checked against the allow lists. Resolves the login, or throws a GitHubError saying why not. */
export async function signedInUser(options: GitHubSignInOptions, accessToken: string): Promise<string> {
  const user = (await api(options, accessToken, "/user")) as { login?: unknown };
  if (typeof user.login !== "string" || !user.login) throw new GitHubError("GitHub did not say who signed in.");
  const login = user.login;
  if (options.allowedUsers?.length && !options.allowedUsers.some((allowed) => allowed.toLowerCase() === login.toLowerCase())) {
    throw new GitHubError(`GitHub user ${login} is not one this hub accepts.`);
  }
  if (options.allowedOrgs?.length) {
    const orgs = ((await api(options, accessToken, "/user/orgs?per_page=100")) as Array<{ login?: unknown }>).map((org) => String(org.login).toLowerCase());
    if (!options.allowedOrgs.some((allowed) => orgs.includes(allowed.toLowerCase()))) {
      throw new GitHubError(`GitHub user ${login} is not a member of an organisation this hub accepts.`);
    }
  }
  return login;
}
