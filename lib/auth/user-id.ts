type SessionUserLike = {
  id?: string | null;
  email?: string | null;
};

function normalizeEmail(email: string | null | undefined) {
  if (typeof email !== "string") {
    return "";
  }

  return email.trim().toLowerCase();
}

export function getBigQueryUserId(user: SessionUserLike) {
  const email = normalizeEmail(user.email);
  if (email) {
    return email;
  }

  return typeof user.id === "string" ? user.id : "";
}

export function getBigQueryUserIdCandidates(user: SessionUserLike) {
  const primary = getBigQueryUserId(user);
  const fallback = typeof user.id === "string" ? user.id : "";

  if (!primary && !fallback) {
    return [] as string[];
  }

  if (!fallback || primary === fallback) {
    return primary ? [primary] : [];
  }

  return [primary, fallback];
}
