import { type Session } from "../types";
import { type KnowledgeBase, type Role } from "./db";

export type KbAccess = "none" | "domain-viewer" | Role;

export function canViewKb(kb: KnowledgeBase, role: Role | null, session: Session): boolean {
  if (role) return true;
  if (kb.visibility === "public") return true;
  return isEmailAllowedForKb(kb, session.user.email);
}

export function accessLabel(kb: KnowledgeBase, role: Role | null, session: Session): KbAccess {
  if (role) return role;
  if (kb.visibility === "public" || isEmailAllowedForKb(kb, session.user.email)) return "domain-viewer";
  return "none";
}

export function normalizeAccessList(value: string | undefined): string {
  return uniqueCsv((value ?? "").split(",").map((item) => item.trim().toLowerCase()).filter(Boolean));
}

export function normalizeDomains(value: string | undefined): string {
  return uniqueCsv((value ?? "").split(",").map(normalizeDomain).filter(Boolean));
}

export function isEmailAllowedForKb(kb: KnowledgeBase, email: string | undefined): boolean {
  const normalizedEmail = normalizeEmail(email);
  if (!normalizedEmail) return false;
  const explicitEmails = csv(kb.access_allowed_emails).map(normalizeEmail);
  if (explicitEmails.includes(normalizedEmail)) return true;
  const domain = normalizedEmail.split("@")[1] ?? "";
  return csv(kb.access_email_domains).map(normalizeDomain).includes(domain);
}

function csv(value: string | undefined): string[] {
  return (value ?? "").split(",").map((item) => item.trim()).filter(Boolean);
}

function uniqueCsv(items: string[]): string {
  return Array.from(new Set(items)).join(",");
}

function normalizeEmail(value: string | undefined): string {
  const email = (value ?? "").trim().toLowerCase();
  return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) ? email : "";
}

function normalizeDomain(value: string): string {
  const domain = value.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "").replace(/\.$/, "");
  return /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/.test(domain) ? domain : "";
}
