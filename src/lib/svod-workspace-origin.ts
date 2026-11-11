export interface WorkspaceOriginCheck {
  origin: string | null;
  referer: string | null;
  reqUrl: string;
  host: string | null;
  configuredOrigins?: (string | null | undefined)[];
}

export function originOf(raw: string | null | undefined): string | null {
  if (!raw) return null;
  try {
    return new URL(raw).origin;
  } catch {
    return null;
  }
}

export function allowedWorkspaceOrigins(
  reqUrl: string,
  host: string | null,
  configuredOrigins?: (string | null | undefined)[],
): Set<string> {
  const allowed = new Set<string>();
  const reqOrigin = originOf(reqUrl);
  if (reqOrigin) allowed.add(reqOrigin);
  const h = (host ?? "").trim();
  if (h && !/[\s/]/.test(h)) {
    for (const proto of ["http", "https"]) {
      const o = originOf(`${proto}://${h}`);
      if (o) allowed.add(o);
    }
  }
  for (const c of configuredOrigins ?? []) {
    const o = originOf(c);
    if (o) allowed.add(o);
  }
  return allowed;
}

export function isWorkspaceSameOrigin(check: WorkspaceOriginCheck): boolean {
  const candidateRaw = check.origin ?? check.referer ?? null;
  if (!candidateRaw) return true;
  const candidate = originOf(candidateRaw);
  if (!candidate) return false;
  return allowedWorkspaceOrigins(check.reqUrl, check.host, check.configuredOrigins).has(candidate);
}

export function isWorkspaceSameOriginRequest(req: Request): boolean {
  return isWorkspaceSameOrigin({
    origin: req.headers.get("origin"),
    referer: req.headers.get("referer"),
    reqUrl: req.url,
    host: req.headers.get("host"),
    configuredOrigins: [process.env.BETTER_AUTH_URL, process.env.NEXT_PUBLIC_APP_URL],
  });
}
