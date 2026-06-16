"use client";

import { useState, useEffect, useCallback, useRef, useTransition } from "react";
import Link from "next/link";
import { signOut, useSession } from "next-auth/react";
import {
  Users, Cpu, Plus, Pencil, Trash2, Zap, CheckCircle2, XCircle,
  ChevronLeft, Info, Power, PowerOff, Server, Star, Webhook, RefreshCw, Trash, Video, Check, UserCircle, LogOut, Eye, EyeOff,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Separator } from "@/components/ui/separator";
import { cn } from "@/lib/utils";

// ─── Provider Presets ───────────────────────────────────────────────

const PROVIDER_PRESETS: Record<string, {
  label: string;
  name: string;
  baseUrl: string;
  providerType: string;
  suggestedModels: string[];
}> = {
  openai:    { label: "OpenAI",              name: "OpenAI",       baseUrl: "https://api.openai.com/v1",                               providerType: "openai-compatible", suggestedModels: ["gpt-4.1", "gpt-4.1-mini", "gpt-4o", "gpt-4o-mini", "o4-mini", "o3-mini"] },
  gemini:    { label: "Google Gemini",       name: "Google Gemini",baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai", providerType: "openai-compatible", suggestedModels: ["gemini-2.5-pro-preview-03-25", "gemini-2.5-flash-preview-04-17", "gemini-2.0-flash", "gemini-1.5-pro"] },
  groq:      { label: "Groq",               name: "Groq",         baseUrl: "https://api.groq.com/openai/v1",                          providerType: "openai-compatible", suggestedModels: ["llama-3.3-70b-versatile", "llama-3.1-8b-instant", "gemma2-9b-it"] },
  anthropic: { label: "Anthropic (Claude)", name: "Anthropic",    baseUrl: "https://api.anthropic.com/v1",                            providerType: "anthropic",         suggestedModels: ["claude-opus-4-6", "claude-sonnet-4-6", "claude-haiku-4-5-20251001"] },
  bedrock:   { label: "AWS Bedrock",        name: "AWS Bedrock",  baseUrl: "",                                                        providerType: "bedrock",           suggestedModels: ["anthropic.claude-3-5-sonnet-20241022-v2:0", "anthropic.claude-3-5-haiku-20241022-v1:0", "meta.llama3-70b-instruct-v1:0", "mistral.mistral-large-2402-v1:0", "amazon.nova-pro-v1:0"] },
  mistral:   { label: "Mistral",            name: "Mistral",      baseUrl: "https://api.mistral.ai/v1",                               providerType: "openai-compatible", suggestedModels: ["mistral-large-latest", "mistral-small-latest", "open-mixtral-8x22b"] },
  deepseek:  { label: "DeepSeek",           name: "DeepSeek",     baseUrl: "https://api.deepseek.com/v1",                             providerType: "openai-compatible", suggestedModels: ["deepseek-chat", "deepseek-reasoner"] },
  together:  { label: "Together AI",        name: "Together AI",  baseUrl: "https://api.together.xyz/v1",                             providerType: "openai-compatible", suggestedModels: ["meta-llama/Meta-Llama-3.1-70B-Instruct-Turbo", "mistralai/Mixtral-8x7B-Instruct-v0.1"] },
  ollama:    { label: "Ollama (Local)",     name: "Ollama",       baseUrl: "http://localhost:11434/v1",                               providerType: "openai-compatible", suggestedModels: ["llama3.2", "llama3.1", "mistral", "qwen2.5", "phi4"] },
  custom:    { label: "Custom / Self-hosted",name: "",            baseUrl: "",                                                        providerType: "openai-compatible", suggestedModels: [] },
};

const BEDROCK_REGIONS = [
  { value: "us-east-1",      label: "US East (N. Virginia)" },
  { value: "us-west-2",      label: "US West (Oregon)" },
  { value: "eu-west-1",      label: "Europe (Ireland)" },
  { value: "eu-central-1",   label: "Europe (Frankfurt)" },
  { value: "ap-southeast-1", label: "Asia Pacific (Singapore)" },
  { value: "ap-northeast-1", label: "Asia Pacific (Tokyo)" },
  { value: "ap-south-1",     label: "Asia Pacific (Mumbai)" },
];

// ─── Types ─────────────────────────────────────────────────────────

interface Account {
  id: string;
  accountId: string;
  name: string;
  type: string;
  dsn: string;
  apiKey: string;
  status: string;
  requestCount: number;
  dailyCount: number;
  dailyResetAt: string | null;
  cooldownUntil: string | null;
  lastUsedAt: string | null;
  createdAt: string;
  inmailBalance?: { premium: number | null; recruiter: number | null; salesNavigator: number | null } | null;
}

const ACCOUNT_TYPE_META: Record<string, { label: string; color: string }> = {
  LINKEDIN:  { label: "LinkedIn",  color: "bg-[#0077B5]/10 text-[#0077B5] border-[#0077B5]/30" },
  EMAIL:     { label: "Email",     color: "bg-violet-500/10 text-violet-500 border-violet-500/30" },
  WHATSAPP:  { label: "WhatsApp",  color: "bg-emerald-500/10 text-emerald-600 border-emerald-500/30" },
};

interface AiProvider {
  id: string;
  name: string;
  provider: string;
  baseUrl: string;
  apiKey: string;
  secretKey?: string | null;
  models: string[];
  isDefault: boolean;
  createdAt: string;
}

// ─── Small helpers ──────────────────────────────────────────────────

function Spinner({ className }: { className?: string }) {
  return (
    <svg className={cn("animate-spin", className)} fill="none" viewBox="0 0 24 24">
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
    </svg>
  );
}

function StatCard({ label, value, color }: { label: string; value: number | string; color?: string }) {
  return (
    <Card>
      <CardContent className="p-5 text-center">
        <p className={cn("text-2xl font-bold", color ?? "text-foreground")}>{value}</p>
        <p className="text-xs text-muted-foreground mt-1">{label}</p>
      </CardContent>
    </Card>
  );
}

function AlertBanner({ success, message }: { success: boolean; message: string }) {
  return (
    <div className={cn(
      "flex items-start gap-2 text-sm p-3 rounded-lg border",
      success
        ? "bg-emerald-50 border-emerald-200 text-emerald-700 dark:bg-emerald-950/30 dark:border-emerald-800 dark:text-emerald-400"
        : "bg-destructive/5 border-destructive/20 text-destructive",
    )}>
      {success ? <CheckCircle2 className="h-4 w-4 shrink-0 mt-0.5" /> : <XCircle className="h-4 w-4 shrink-0 mt-0.5" />}
      <span>{message}</span>
    </div>
  );
}

const STATUS_CONFIG: Record<string, { dot: string; badge: string; card: string; label: string }> = {
  ACTIVE:   { dot: "bg-emerald-500",               badge: "bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-950/40 dark:text-emerald-400 dark:border-emerald-800",   card: "border-emerald-200/70 bg-emerald-50/30 dark:border-emerald-900/40 dark:bg-emerald-950/10", label: "Active" },
  BUSY:     { dot: "bg-amber-500 animate-pulse",   badge: "bg-amber-50 text-amber-700 border-amber-200 dark:bg-amber-950/40 dark:text-amber-400 dark:border-amber-800",             card: "border-amber-200/70 bg-amber-50/30 dark:border-amber-900/40 dark:bg-amber-950/10",         label: "Processing" },
  COOLDOWN: { dot: "bg-orange-500",                badge: "bg-orange-50 text-orange-700 border-orange-200 dark:bg-orange-950/40 dark:text-orange-400 dark:border-orange-800",       card: "border-orange-200/70 bg-orange-50/30",                                                       label: "Cooldown" },
  DISABLED: { dot: "bg-muted-foreground/40",       badge: "bg-muted text-muted-foreground border-border",                                                                           card: "border-border bg-muted/20 opacity-60",                                                       label: "Disabled" },
};

const PROVIDER_TYPE_LABELS: Record<string, string> = {
  "openai-compatible": "OpenAI-Compatible",
  "anthropic": "Anthropic",
  "bedrock": "AWS Bedrock",
};

// ─── Page ───────────────────────────────────────────────────────────

export default function SettingsPage() {
  const [activeTab, setActiveTab] = useState<"accounts" | "models" | "webhooks" | "interview" | "profile" | "users">("accounts");

  // ─── Users tab state (ADMIN only) ───────────────────────────────────────────
  type UserRow = { id: string; email: string; name: string | null; role: string; createdAt: string };
  const [usersList, setUsersList] = useState<UserRow[]>([]);
  const [usersLoading, setUsersLoading] = useState(false);
  const [newUserEmail, setNewUserEmail] = useState("");
  const [newUserName, setNewUserName] = useState("");
  const [newUserPassword, setNewUserPassword] = useState("");
  const [newUserRole, setNewUserRole] = useState("RECRUITER");
  const [userFormMsg, setUserFormMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [creatingUser, setCreatingUser] = useState(false);
  const [editingUserId, setEditingUserId] = useState<string | null>(null);
  const [editUserRole, setEditUserRole] = useState("");
  const [editUserName, setEditUserName] = useState("");
  const [editUserPassword, setEditUserPassword] = useState("");

  const fetchUsers = useCallback(async () => {
    setUsersLoading(true);
    try {
      const res = await fetch("/api/auth/users");
      if (res.ok) setUsersList((await res.json()).users);
    } finally {
      setUsersLoading(false);
    }
  }, []);

  // ─── Profile tab state ───────────────────────────────────────────────────────
  const { data: session, update: updateSession } = useSession();
  const [profileName, setProfileName] = useState("");
  const [profileEmail, setProfileEmail] = useState("");
  const [profileCurrentPw, setProfileCurrentPw] = useState("");
  const [profileNewPw, setProfileNewPw] = useState("");
  const [profileConfirmPw, setProfileConfirmPw] = useState("");
  const [profileMsg, setProfileMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [isPendingProfile, startProfileTransition] = useTransition();
  const [showCurrentPw, setShowCurrentPw] = useState(false);
  const [showNewPw, setShowNewPw] = useState(false);
  const [showConfirmPw, setShowConfirmPw] = useState(false);
  const [showNewUserPw, setShowNewUserPw] = useState(false);

  // Seed form from session on mount / session change.
  useEffect(() => {
    if (session?.user) {
      setProfileName((session.user as any).name ?? "");
      setProfileEmail(session.user.email ?? "");
    }
  }, [session]);

  // ── Interview config state ──
  const [interviewCfg, setInterviewCfg] = useState<{
    globalQuestions: Array<{ id: string; order: number; text: string; mustAsk?: boolean; idealAnswer?: string; weight?: number }>;
    defaultAgentName: string;
  }>({ globalQuestions: [], defaultAgentName: "HR-Recruiter-Agent" });
  const [globalTemplateSubject, setGlobalTemplateSubject] = useState("");
  const [globalTemplateBody, setGlobalTemplateBody] = useState("");
  const [savingTemplate, setSavingTemplate] = useState(false);
  const [savedTemplate, setSavedTemplate] = useState(false);
  const interviewBodyRef = useRef<HTMLTextAreaElement>(null);
  const INTERVIEW_LINK_TOKEN = "{{interviewLink}}";
  const globalTemplateHasLink = /\{\{\s*interviewLink\s*\}\}/i.test(globalTemplateBody);
  const [interviewCfgLoading, setInterviewCfgLoading] = useState(false);
  const [interviewCfgSaving, setInterviewCfgSaving] = useState(false);
  const [interviewCfgSaved, setInterviewCfgSaved] = useState(false);
  const [interviewCfgError, setInterviewCfgError] = useState<string | null>(null);
  const [newQuestionText, setNewQuestionText] = useState("");
  const [newQuestionMust, setNewQuestionMust] = useState(false);

  const fetchInterviewCfg = useCallback(async () => {
    setInterviewCfgLoading(true);
    try {
      const res = await fetch("/api/interview/config");
      if (res.ok) {
        const data = await res.json();
        setInterviewCfg({
          globalQuestions: Array.isArray(data.globalQuestions) ? data.globalQuestions : [],
          defaultAgentName: data.defaultAgentName ?? "HR-Recruiter-Agent",
        });
        const tmpl = data.defaultMessageTemplate || {};
        setGlobalTemplateSubject(typeof tmpl.subject === "string" ? tmpl.subject : "");
        setGlobalTemplateBody(typeof tmpl.body === "string" ? tmpl.body : "");
      }
    } catch { /* leave defaults */ } finally {
      setInterviewCfgLoading(false);
    }
  }, []);

  async function saveInterviewCfg(patch: typeof interviewCfg) {
    setInterviewCfgSaving(true);
    setInterviewCfgError(null);
    try {
      const res = await fetch("/api/interview/config", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        setInterviewCfgError(d.error || `Save failed (${res.status})`);
        setTimeout(() => setInterviewCfgError(null), 4000);
        return;
      }
      setInterviewCfgSaved(true);
      setTimeout(() => setInterviewCfgSaved(false), 2000);
    } catch {
      setInterviewCfgError("Network error — changes not saved");
      setTimeout(() => setInterviewCfgError(null), 4000);
    } finally {
      setInterviewCfgSaving(false);
    }
  }

  function addGlobalQuestion() {
    if (!newQuestionText.trim()) return;
    const next = {
      ...interviewCfg,
      globalQuestions: [
        ...interviewCfg.globalQuestions,
        {
          id: `gq_${Date.now()}`,
          order: interviewCfg.globalQuestions.length + 1,
          text: newQuestionText.trim(),
          mustAsk: newQuestionMust,
          weight: 1.0,
        },
      ],
    };
    setInterviewCfg(next);
    saveInterviewCfg(next);
    setNewQuestionText("");
    setNewQuestionMust(false);
  }

  function removeGlobalQuestion(id: string) {
    const next = {
      ...interviewCfg,
      globalQuestions: interviewCfg.globalQuestions.filter(q => q.id !== id),
    };
    setInterviewCfg(next);
    saveInterviewCfg(next);
  }

  function insertInterviewLinkToken() {
    const el = interviewBodyRef.current;
    if (!el) {
      setGlobalTemplateBody(b => (b ? `${b} ${INTERVIEW_LINK_TOKEN}` : INTERVIEW_LINK_TOKEN));
      return;
    }
    const start = el.selectionStart ?? globalTemplateBody.length;
    const end = el.selectionEnd ?? globalTemplateBody.length;
    setGlobalTemplateBody(globalTemplateBody.slice(0, start) + INTERVIEW_LINK_TOKEN + globalTemplateBody.slice(end));
    requestAnimationFrame(() => {
      el.focus();
      const pos = start + INTERVIEW_LINK_TOKEN.length;
      el.setSelectionRange(pos, pos);
    });
  }

  async function saveGlobalTemplate() {
    if (globalTemplateBody.trim() && !globalTemplateHasLink) return;
    setSavingTemplate(true);
    setInterviewCfgError(null);
    try {
      const defaultMessageTemplate = globalTemplateBody.trim()
        ? { subject: globalTemplateSubject.trim() || undefined, body: globalTemplateBody }
        : {};
      const res = await fetch("/api/interview/config", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ defaultMessageTemplate }),
      });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        setInterviewCfgError(d.error || `Save failed (${res.status})`);
        setTimeout(() => setInterviewCfgError(null), 4000);
        return;
      }
      setSavedTemplate(true);
      setTimeout(() => setSavedTemplate(false), 2000);
    } catch {
      setInterviewCfgError("Network error — changes not saved");
      setTimeout(() => setInterviewCfgError(null), 4000);
    } finally {
      setSavingTemplate(false);
    }
  }

  // ── Webhooks state ──
  const [webhooks, setWebhooks] = useState<any[]>([]);
  const [webhooksLoading, setWebhooksLoading] = useState(false);
  const [webhookSelectedIds, setWebhookSelectedIds] = useState<Set<string>>(new Set());
  const [webhookRegistering, setWebhookRegistering] = useState(false);
  const [webhookMsg, setWebhookMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [appUrl, setAppUrl] = useState(
    typeof window !== "undefined" ? window.location.origin : "",
  );

  const fetchWebhooks = useCallback(async () => {
    setWebhooksLoading(true);
    try {
      const res = await fetch("/api/webhooks/unipile/register");
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to load webhooks");
      setWebhooks(data.webhooks ?? []);
    } catch (err: any) {
      setWebhooks([]);
    } finally {
      setWebhooksLoading(false);
    }
  }, []);

  async function handleRegisterWebhooks() {
    setWebhookRegistering(true);
    setWebhookMsg(null);
    try {
      const res = await fetch("/api/webhooks/unipile/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          accountIds: [...webhookSelectedIds],
          appUrl,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Registration failed");
      setWebhookMsg({ ok: true, text: "Both webhooks registered successfully." });
      await fetchWebhooks();
    } catch (err: any) {
      setWebhookMsg({ ok: false, text: err.message });
    } finally {
      setWebhookRegistering(false);
    }
  }

  async function handleDeleteWebhook(webhookId: string) {
    try {
      const res = await fetch("/api/webhooks/unipile/register", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ webhookId }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      setWebhooks(prev => prev.filter(w => w.id !== webhookId && w.webhook_id !== webhookId));
    } catch (err: any) {
      setWebhookMsg({ ok: false, text: err.message });
    }
  }

  // ── Accounts state ──
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [accountsLoading, setAccountsLoading] = useState(true);
  const [accountsError, setAccountsError] = useState<string | null>(null);

  const [showAddForm, setShowAddForm] = useState(false);
  const [formName, setFormName] = useState("");
  const [formAccountId, setFormAccountId] = useState("");
  const [formDsn, setFormDsn] = useState("");
  const [formApiKey, setFormApiKey] = useState("");
  const [formType, setFormType] = useState("LINKEDIN");
  const [formSubmitting, setFormSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<{ success?: boolean; message?: string; error?: string } | null>(null);
  const [testing, setTesting] = useState(false);

  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const [editDsn, setEditDsn] = useState("");
  const [editApiKey, setEditApiKey] = useState("");
  const [editAccountId, setEditAccountId] = useState("");

  // ── Providers state ──
  const [aiProviders, setAiProviders] = useState<AiProvider[]>([]);
  const [providersLoading, setProvidersLoading] = useState(true);

  const [showAddProvider, setShowAddProvider] = useState(false);
  const [selectedPreset, setSelectedPreset] = useState("openai");
  const [newProviderName, setNewProviderName] = useState("OpenAI");
  const [newProviderApiKey, setNewProviderApiKey] = useState("");
  const [newProviderCustomBaseUrl, setNewProviderCustomBaseUrl] = useState("");
  const [newProviderCustomType, setNewProviderCustomType] = useState("openai-compatible");
  const [newProviderSecretKey, setNewProviderSecretKey] = useState("");
  const [newSelectedModels, setNewSelectedModels] = useState<string[]>([]);
  const [newCustomModelInput, setNewCustomModelInput] = useState("");
  const [providerTestResult, setProviderTestResult] = useState<{ success: boolean; message: string } | null>(null);
  const [providerTestLoading, setProviderTestLoading] = useState(false);
  const [providerFormError, setProviderFormError] = useState<string | null>(null);
  const [providerSubmitting, setProviderSubmitting] = useState(false);

  const [editingProviderId, setEditingProviderId] = useState<string | null>(null);
  const [editProviderName, setEditProviderName] = useState("");
  const [editProviderApiKey, setEditProviderApiKey] = useState("");
  const [editProviderSecretKey, setEditProviderSecretKey] = useState("");
  const [editSelectedModels, setEditSelectedModels] = useState<string[]>([]);
  const [editCustomModelInput, setEditCustomModelInput] = useState("");
  const [editTestResult, setEditTestResult] = useState<{ success: boolean; message: string } | null>(null);
  const [editTestLoading, setEditTestLoading] = useState(false);
  const [editSubmitting, setEditSubmitting] = useState(false);

  const [quickTestId, setQuickTestId] = useState<string | null>(null);
  const [quickTestResults, setQuickTestResults] = useState<Record<string, { success: boolean; message: string }>>({});

  // ── Fetch ──

  const fetchAccounts = useCallback(async () => {
    try {
      const res = await fetch("/api/accounts", { cache: "no-store" });
      if (!res.ok) throw new Error("Failed to fetch accounts");
      const data = await res.json();
      setAccounts(data.accounts || []);
    } catch (err: any) {
      setAccountsError(err.message);
    } finally {
      setAccountsLoading(false);
    }
  }, []);

  const fetchProviders = useCallback(async () => {
    try {
      const res = await fetch("/api/ai-providers", { cache: "no-store" });
      if (!res.ok) throw new Error("Failed");
      setAiProviders(await res.json());
    } catch { /* silent */ } finally {
      setProvidersLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchAccounts();
    fetchProviders();
    const t = setInterval(fetchAccounts, 5000);
    return () => clearInterval(t);
  }, [fetchAccounts, fetchProviders]);

  // ── Account handlers ──

  async function handleTestConnection() {
    if (!formDsn || !formApiKey || !formAccountId) {
      setTestResult({ error: "Fill in Account ID, DSN, and API Key first." });
      return;
    }
    setTesting(true); setTestResult(null);
    try {
      const res = await fetch("/api/accounts/test", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ dsn: formDsn, apiKey: formApiKey, accountId: formAccountId }),
      });
      setTestResult(await res.json());
    } catch { setTestResult({ error: "Network error." }); } finally { setTesting(false); }
  }

  async function handleAddAccount(e: React.FormEvent) {
    e.preventDefault();
    if (!formAccountId || !formDsn || !formApiKey) return;
    setFormSubmitting(true); setFormError(null);
    try {
      const res = await fetch("/api/accounts", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: formName, accountId: formAccountId, dsn: formDsn, apiKey: formApiKey, type: formType }),
      });
      const data = await res.json();
      if (!res.ok) { setFormError(data.error || "Failed"); return; }
      setFormName(""); setFormAccountId(""); setFormDsn(""); setFormApiKey(""); setFormType("LINKEDIN");
      setShowAddForm(false); setTestResult(null);
      fetchAccounts();
    } catch { setFormError("Network error"); } finally { setFormSubmitting(false); }
  }

  async function handleDeleteAccount(id: string) {
    if (!confirm("Delete this account?")) return;
    try {
      await fetch(`/api/accounts/${id}`, { method: "DELETE" });
      fetchAccounts();
    } catch { alert("Network error"); }
  }

  async function handleToggleStatus(id: string, currentStatus: string) {
    const newStatus = currentStatus === "DISABLED" ? "ACTIVE" : "DISABLED";
    try {
      await fetch(`/api/accounts/${id}`, {
        method: "PUT", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: newStatus }),
      });
      fetchAccounts();
    } catch { alert("Failed to update"); }
  }

  async function handleSaveEdit(id: string) {
    try {
      const update: any = { name: editName, dsn: editDsn, accountId: editAccountId };
      if (editApiKey && !editApiKey.includes("•")) update.apiKey = editApiKey;
      await fetch(`/api/accounts/${id}`, {
        method: "PUT", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(update),
      });
      setEditingId(null); fetchAccounts();
    } catch { alert("Failed to update"); }
  }

  function startEditing(account: Account) {
    setEditingId(account.id); setEditName(account.name); setEditDsn(account.dsn);
    setEditApiKey(account.apiKey.length > 14 ? `••••••••${account.apiKey.slice(-4)}` : account.apiKey);
    setEditAccountId(account.accountId);
  }

  // ── Provider helpers ──

  function getEffectiveBaseUrl() {
    if (selectedPreset === "bedrock" || selectedPreset === "custom") return newProviderCustomBaseUrl;
    return PROVIDER_PRESETS[selectedPreset]?.baseUrl ?? "";
  }

  function getEffectiveProviderType() {
    return selectedPreset === "custom" ? newProviderCustomType : PROVIDER_PRESETS[selectedPreset]?.providerType ?? "openai-compatible";
  }

  function handlePresetChange(preset: string) {
    setSelectedPreset(preset);
    const p = PROVIDER_PRESETS[preset];
    if (p.name) setNewProviderName(p.name);
    setNewSelectedModels([]); setNewCustomModelInput(""); setNewProviderSecretKey(""); setProviderTestResult(null);
    if (preset === "bedrock") setNewProviderCustomBaseUrl("us-east-1");
    else if (preset !== "custom") setNewProviderCustomBaseUrl("");
  }

  function toggleNewModel(model: string) {
    setNewSelectedModels(p => p.includes(model) ? p.filter(m => m !== model) : [...p, model]);
  }

  function addNewCustomModel() {
    const m = newCustomModelInput.trim();
    if (!m || newSelectedModels.includes(m)) return;
    setNewSelectedModels(p => [...p, m]); setNewCustomModelInput("");
  }

  function toggleEditModel(model: string) {
    setEditSelectedModels(p => p.includes(model) ? p.filter(m => m !== model) : [...p, model]);
  }

  function addEditCustomModel() {
    const m = editCustomModelInput.trim();
    if (!m || editSelectedModels.includes(m)) return;
    setEditSelectedModels(p => [...p, m]); setEditCustomModelInput("");
  }

  // ── Provider handlers ──

  async function handleTestNewProvider() {
    const baseUrl = getEffectiveBaseUrl();
    const model = newSelectedModels[0];
    const isBedrock = selectedPreset === "bedrock";
    if (!baseUrl || !newProviderApiKey || !model) {
      setProviderTestResult({ success: false, message: "Select a model and enter credentials first." });
      return;
    }
    if (isBedrock && !newProviderSecretKey) {
      setProviderTestResult({ success: false, message: "Secret Access Key is required for Bedrock." });
      return;
    }
    setProviderTestLoading(true); setProviderTestResult(null);
    try {
      const res = await fetch("/api/ai-providers/test", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider: getEffectiveProviderType(), baseUrl, apiKey: newProviderApiKey, ...(isBedrock && { secretKey: newProviderSecretKey }), model }),
      });
      const data = await res.json();
      setProviderTestResult({ success: data.success, message: data.error || "Connection successful!" });
    } catch (err: any) {
      setProviderTestResult({ success: false, message: err.message });
    } finally { setProviderTestLoading(false); }
  }

  async function handleAddProvider(e: React.FormEvent) {
    e.preventDefault();
    if (newSelectedModels.length === 0 || !newProviderApiKey || !newProviderName) return;
    const baseUrl = getEffectiveBaseUrl();
    if (!baseUrl) { setProviderFormError("Base URL is required"); return; }
    setProviderSubmitting(true); setProviderFormError(null);
    try {
      const res = await fetch("/api/ai-providers", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: newProviderName, provider: getEffectiveProviderType(), baseUrl, apiKey: newProviderApiKey,
          ...(newProviderSecretKey && { secretKey: newProviderSecretKey }),
          models: newSelectedModels, isDefault: aiProviders.length === 0,
        }),
      });
      if (!res.ok) { const d = await res.json(); setProviderFormError(d.error || "Failed"); return; }
      setSelectedPreset("openai"); setNewProviderName("OpenAI"); setNewProviderApiKey(""); setNewProviderSecretKey("");
      setNewProviderCustomBaseUrl(""); setNewSelectedModels([]); setNewCustomModelInput("");
      setShowAddProvider(false); setProviderTestResult(null);
      fetchProviders();
    } catch { setProviderFormError("Network error"); } finally { setProviderSubmitting(false); }
  }

  function startEditProvider(provider: AiProvider) {
    setEditingProviderId(provider.id); setEditProviderName(provider.name);
    setEditProviderApiKey(`••••${provider.apiKey.slice(-4)}`);
    setEditProviderSecretKey(provider.secretKey ? "••••" : "");
    setEditSelectedModels(provider.models || []); setEditCustomModelInput(""); setEditTestResult(null);
  }

  async function handleSaveEditProvider(id: string) {
    if (editSelectedModels.length === 0 || !editProviderName) return;
    setEditSubmitting(true);
    try {
      const update: any = { id, name: editProviderName, models: editSelectedModels };
      if (editProviderApiKey && !editProviderApiKey.startsWith("••••")) update.apiKey = editProviderApiKey;
      if (editProviderSecretKey && editProviderSecretKey !== "••••") update.secretKey = editProviderSecretKey;
      const res = await fetch("/api/ai-providers", {
        method: "PUT", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(update),
      });
      if (res.ok) { setEditingProviderId(null); fetchProviders(); }
    } catch { alert("Failed to update"); } finally { setEditSubmitting(false); }
  }

  async function handleTestEditProvider(provider: AiProvider) {
    const model = editSelectedModels[0] || provider.models?.[0];
    if (!model) { setEditTestResult({ success: false, message: "Add at least one model first." }); return; }
    setEditTestLoading(true); setEditTestResult(null);
    try {
      const res = await fetch("/api/ai-providers/test", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ providerId: provider.id, model }),
      });
      const data = await res.json();
      setEditTestResult({ success: data.success, message: data.error || "Connection successful!" });
    } catch (err: any) {
      setEditTestResult({ success: false, message: err.message });
    } finally { setEditTestLoading(false); }
  }

  async function handleQuickTest(provider: AiProvider) {
    const model = provider.models?.[0];
    if (!model) return;
    setQuickTestId(provider.id);
    try {
      const res = await fetch("/api/ai-providers/test", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ providerId: provider.id, model }),
      });
      const data = await res.json();
      setQuickTestResults(p => ({ ...p, [provider.id]: { success: data.success, message: data.error || "Connection OK" } }));
    } catch {
      setQuickTestResults(p => ({ ...p, [provider.id]: { success: false, message: "Network error" } }));
    } finally { setQuickTestId(null); }
  }

  async function handleDeleteProvider(id: string) {
    const provider = aiProviders.find(p => p.id === id);
    if (!provider) return;
    const msg = provider.isDefault
      ? "This is your default provider. Removing it will fall back to the OPENAI_API_KEY env variable. Continue?"
      : "Remove this AI provider?";
    if (!confirm(msg)) return;
    try {
      const res = await fetch(`/api/ai-providers?id=${id}`, { method: "DELETE" });
      if (res.ok) fetchProviders();
    } catch { alert("Network error"); }
  }

  async function handleSetDefault(id: string) {
    try {
      await fetch("/api/ai-providers", {
        method: "PUT", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, isDefault: true }),
      });
      fetchProviders();
    } catch { alert("Failed"); }
  }

  const activeCount = accounts.filter(a => a.status === "ACTIVE" || a.status === "BUSY").length;
  const currentPreset = PROVIDER_PRESETS[selectedPreset];

  // ── Render ─────────────────────────────────────────────────────────

  return (
    <div className="p-8 space-y-6">
      {/* Header */}
      <div>
        <Link href="/" className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground transition-colors mb-3">
          <ChevronLeft className="h-3.5 w-3.5" />
          Jobs
        </Link>
        <h1 className="text-2xl font-bold text-foreground">Settings</h1>
        <p className="text-sm text-muted-foreground mt-0.5">Configure LinkedIn scraping accounts and AI model providers.</p>
      </div>

      <Tabs value={activeTab} onValueChange={(v) => {
        const tab = v as "accounts" | "models" | "webhooks" | "interview" | "profile" | "users";
        setActiveTab(tab);
        if (tab === "webhooks") fetchWebhooks();
        if (tab === "interview") fetchInterviewCfg();
        if (tab === "profile") setProfileMsg(null);
        if (tab === "users") fetchUsers();
      }}>
        <TabsList>
          <TabsTrigger value="accounts" className="gap-2">
            <Users className="h-4 w-4" />
            Unipile Accounts
          </TabsTrigger>
          <TabsTrigger value="models" className="gap-2">
            <Cpu className="h-4 w-4" />
            AI Models
          </TabsTrigger>
          <TabsTrigger value="webhooks" className="gap-2">
            <Webhook className="h-4 w-4" />
            Webhooks
          </TabsTrigger>
          <TabsTrigger value="interview" className="gap-2">
            <Video className="h-4 w-4" />
            Interview
          </TabsTrigger>
          <TabsTrigger value="profile" className="gap-2">
            <UserCircle className="h-4 w-4" />
            My Account
          </TabsTrigger>
        </TabsList>

        {/* ═══════════════ ACCOUNTS ═══════════════ */}
        <TabsContent value="accounts" className="mt-5 space-y-5">
          {/* Stats */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <StatCard label="Total Accounts" value={accounts.length} />
            <StatCard label="Active Workers" value={activeCount} color="text-emerald-600 dark:text-emerald-400" />
            <StatCard label="Processing" value={accounts.filter(a => a.status === "BUSY").length} color="text-amber-600 dark:text-amber-400" />
            <StatCard label="In Cooldown" value={accounts.filter(a => a.status === "COOLDOWN").length} color="text-orange-600 dark:text-orange-400" />
          </div>

          {/* Accounts card */}
          <Card>
            {/* Card header */}
            <div className="flex items-center justify-between px-6 py-4">
              <div className="flex items-center gap-2">
                <Users className="h-4 w-4 text-muted-foreground" />
                <span className="text-sm font-semibold text-foreground">Accounts</span>
                {accounts.length > 0 && (
                  <span className="text-xs text-muted-foreground bg-muted px-1.5 py-0.5 rounded-full">{accounts.length}</span>
                )}
              </div>
              <Button
                size="sm"
                variant={showAddForm ? "secondary" : "default"}
                onClick={() => setShowAddForm(!showAddForm)}
                className="gap-1.5 h-8 text-xs"
              >
                <Plus className="h-3.5 w-3.5" />
                Add Account
              </Button>
            </div>

            {/* Add form */}
            {showAddForm && (
              <>
                <Separator />
                <div className="px-6 py-5 bg-muted/30">
                  <p className="text-sm font-medium text-foreground mb-4">New Unipile Account</p>
                  <form onSubmit={handleAddAccount} className="space-y-4">
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                      <div className="space-y-1.5">
                        <Label className="text-xs">Friendly Name</Label>
                        <Input value={formName} onChange={e => setFormName(e.target.value)} placeholder="My LinkedIn Account" className="h-9 text-sm" />
                      </div>
                      <div className="space-y-1.5">
                        <Label className="text-xs">Account Type <span className="text-destructive">*</span></Label>
                        <div className="flex gap-2">
                          {(["LINKEDIN", "EMAIL", "WHATSAPP"] as const).map(t => (
                            <button
                              key={t}
                              type="button"
                              onClick={() => setFormType(t)}
                              className={cn(
                                "flex-1 h-9 text-xs rounded-md border font-medium transition-colors",
                                formType === t
                                  ? ACCOUNT_TYPE_META[t].color + " border-current"
                                  : "border-border text-muted-foreground hover:border-muted-foreground",
                              )}
                            >
                              {ACCOUNT_TYPE_META[t].label}
                            </button>
                          ))}
                        </div>
                      </div>
                    </div>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                      <div className="space-y-1.5">
                        <Label className="text-xs">Account ID <span className="text-destructive">*</span></Label>
                        <Input value={formAccountId} onChange={e => setFormAccountId(e.target.value)} placeholder="abc123def456" required className="h-9 text-sm" />
                      </div>
                    </div>
                    <div className="space-y-1.5">
                      <Label className="text-xs">DSN Endpoint <span className="text-destructive">*</span></Label>
                      <Input type="url" value={formDsn} onChange={e => setFormDsn(e.target.value)} placeholder="https://api36.unipile.com:16688" required className="h-9 text-sm" />
                    </div>
                    <div className="space-y-1.5">
                      <Label className="text-xs">API Key <span className="text-destructive">*</span></Label>
                      <Input type="password" value={formApiKey} onChange={e => setFormApiKey(e.target.value)} placeholder="Your Unipile API key" required className="h-9 text-sm font-mono" />
                    </div>

                    {testResult && (
                      <AlertBanner success={!!testResult.success} message={testResult.message || testResult.error || ""} />
                    )}
                    {formError && <p className="text-sm text-destructive">{formError}</p>}

                    <div className="flex items-center justify-between pt-1">
                      <Button type="button" variant="outline" size="sm" onClick={handleTestConnection}
                        disabled={testing || !formDsn || !formApiKey || !formAccountId} className="gap-1.5 h-8 text-xs">
                        {testing ? <><Spinner className="h-3 w-3" /> Testing...</> : <><Zap className="h-3 w-3" /> Test Connection</>}
                      </Button>
                      <div className="flex gap-2">
                        <Button type="button" variant="ghost" size="sm" className="h-8 text-xs"
                          onClick={() => { setShowAddForm(false); setTestResult(null); setFormError(null); }}>
                          Cancel
                        </Button>
                        <Button type="submit" size="sm" className="h-8 text-xs"
                          disabled={formSubmitting || !formAccountId || !formDsn || !formApiKey}>
                          {formSubmitting ? "Saving..." : "Save Account"}
                        </Button>
                      </div>
                    </div>
                  </form>
                </div>
              </>
            )}

            <Separator />

            {/* Account list */}
            <div className="p-4 space-y-2">
              {accountsLoading ? (
                <div className="space-y-2 animate-pulse">
                  {[...Array(2)].map((_, i) => <div key={i} className="h-20 rounded-lg bg-muted" />)}
                </div>
              ) : accountsError ? (
                <div className="rounded-lg border border-destructive/20 bg-destructive/5 p-4 text-sm text-destructive text-center">
                  {accountsError}
                </div>
              ) : accounts.length === 0 ? (
                <div className="py-10 text-center">
                  <div className="h-10 w-10 rounded-full bg-muted flex items-center justify-center mx-auto mb-3">
                    <Users className="h-5 w-5 text-muted-foreground" />
                  </div>
                  <p className="text-sm font-medium text-foreground mb-1">No accounts yet</p>
                  <p className="text-xs text-muted-foreground">Add a Unipile account to start scraping LinkedIn profiles.</p>
                </div>
              ) : (
                accounts.map((account) => {
                  const sc = STATUS_CONFIG[account.status] || STATUS_CONFIG.DISABLED;
                  const isEditing = editingId === account.id;
                  const cooldownRemaining = account.cooldownUntil
                    ? Math.max(0, Math.ceil((new Date(account.cooldownUntil).getTime() - Date.now()) / 60000))
                    : 0;

                  return (
                    <div key={account.id} className={cn("rounded-lg border p-4 transition-colors", sc.card)}>
                      {isEditing ? (
                        <div className="space-y-3">
                          <p className="text-xs font-semibold text-foreground mb-3">Edit Account</p>
                          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                            <Input value={editName} onChange={e => setEditName(e.target.value)} placeholder="Friendly name" className="h-8 text-xs" />
                            <Input value={editAccountId} onChange={e => setEditAccountId(e.target.value)} placeholder="Account ID" className="h-8 text-xs" />
                          </div>
                          <Input type="url" value={editDsn} onChange={e => setEditDsn(e.target.value)} placeholder="DSN Endpoint" className="h-8 text-xs" />
                          <Input value={editApiKey} onChange={e => setEditApiKey(e.target.value)} placeholder="API Key (leave masked to keep)" className="h-8 text-xs font-mono" />
                          <div className="flex justify-end gap-2">
                            <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={() => setEditingId(null)}>Cancel</Button>
                            <Button size="sm" className="h-7 text-xs bg-emerald-600 hover:bg-emerald-500" onClick={() => handleSaveEdit(account.id)}>Save</Button>
                          </div>
                        </div>
                      ) : (
                        <div className="flex items-start gap-3">
                          <div className={cn("h-2 w-2 rounded-full mt-2 shrink-0", sc.dot)} />
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2 mb-1 flex-wrap">
                              <span className="text-sm font-medium text-foreground">{account.name || account.accountId}</span>
                              <Badge variant="outline" className={cn("text-[10px] h-4 px-1.5", sc.badge)}>{sc.label}</Badge>
                              {account.type && ACCOUNT_TYPE_META[account.type as keyof typeof ACCOUNT_TYPE_META] && (
                                <Badge variant="outline" className={cn("text-[10px] h-4 px-1.5", ACCOUNT_TYPE_META[account.type as keyof typeof ACCOUNT_TYPE_META].color)}>
                                  {ACCOUNT_TYPE_META[account.type as keyof typeof ACCOUNT_TYPE_META].label}
                                </Badge>
                              )}
                            </div>
                            <p className="text-[11px] text-muted-foreground font-mono mb-1.5 truncate">
                              ID: {account.accountId}
                            </p>
                            <div className="flex flex-wrap gap-x-4 gap-y-0.5 text-[11px] text-muted-foreground">
                              <span>DSN: <span className="text-foreground/70">{account.dsn}</span></span>
                              <span>Key: <span className="font-mono text-foreground/70">••••{account.apiKey.slice(-4)}</span></span>
                            </div>
                            <div className="flex flex-wrap gap-x-4 gap-y-0.5 text-[11px] text-muted-foreground mt-1">
                              <span>Requests: <span className="font-mono font-medium text-foreground/80">{account.requestCount}</span></span>
                              <span>Today: <span className="font-mono font-medium text-foreground/80">{account.dailyCount}</span></span>
                              {account.lastUsedAt && (
                                <span>Last used: {new Date(account.lastUsedAt).toLocaleTimeString()}</span>
                              )}
                              {cooldownRemaining > 0 && (
                                <span className="text-orange-600 dark:text-orange-400 font-medium">Cooldown: {cooldownRemaining}m</span>
                              )}
                            </div>
                            {account.type === "LINKEDIN" && account.inmailBalance && (
                              <div className="flex flex-wrap gap-x-4 gap-y-0.5 text-[11px] text-muted-foreground mt-0.5">
                                {account.inmailBalance.premium != null && (
                                  <span>InMail credits: <span className="font-mono font-medium text-foreground/80">{account.inmailBalance.premium}</span></span>
                                )}
                                {account.inmailBalance.recruiter != null && (
                                  <span>Recruiter: <span className="font-mono font-medium text-foreground/80">{account.inmailBalance.recruiter}</span></span>
                                )}
                                {account.inmailBalance.salesNavigator != null && (
                                  <span>Sales Nav: <span className="font-mono font-medium text-foreground/80">{account.inmailBalance.salesNavigator}</span></span>
                                )}
                              </div>
                            )}
                          </div>
                          <div className="flex items-center gap-0.5 shrink-0">
                            <Button variant="ghost" size="icon" className="h-8 w-8"
                              title={account.status === "DISABLED" ? "Enable" : "Disable"}
                              onClick={() => handleToggleStatus(account.id, account.status)}>
                              {account.status === "DISABLED"
                                ? <Power className="h-3.5 w-3.5 text-emerald-600" />
                                : <PowerOff className="h-3.5 w-3.5 text-muted-foreground" />}
                            </Button>
                            <Button variant="ghost" size="icon" className="h-8 w-8" title="Edit"
                              onClick={() => startEditing(account)}>
                              <Pencil className="h-3.5 w-3.5 text-muted-foreground" />
                            </Button>
                            <Button variant="ghost" size="icon" className="h-8 w-8 hover:text-destructive" title="Delete"
                              disabled={account.status === "BUSY"}
                              onClick={() => handleDeleteAccount(account.id)}>
                              <Trash2 className="h-3.5 w-3.5" />
                            </Button>
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })
              )}
            </div>
          </Card>

          {/* Info note */}
          <div className="flex gap-3 p-4 rounded-lg border border-dashed text-sm text-muted-foreground">
            <Info className="h-4 w-4 shrink-0 mt-0.5" />
            <p>
              The evaluator connects to <strong className="text-foreground font-medium">Unipile</strong> to retrieve
              LinkedIn profile data. Enter your account credentials above to enable candidate syncing.
            </p>
          </div>
        </TabsContent>

        {/* ═══════════════ MODELS ═══════════════ */}
        <TabsContent value="models" className="mt-5 space-y-5">
          {/* Stats */}
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
            <StatCard label="Providers" value={aiProviders.length} />
            <StatCard label="Total Models" value={aiProviders.reduce((s, p) => s + (p.models?.length || 0), 0)} color="text-primary" />
            <StatCard label="Default Provider" value={aiProviders.find(p => p.isDefault)?.name || "Env Key"} color="text-emerald-600 dark:text-emerald-400" />
          </div>

          {/* Providers card */}
          <Card>
            {/* Card header */}
            <div className="flex items-center justify-between px-6 py-4">
              <div className="flex items-center gap-2">
                <Server className="h-4 w-4 text-muted-foreground" />
                <span className="text-sm font-semibold text-foreground">AI Providers</span>
                {aiProviders.length > 0 && (
                  <span className="text-xs text-muted-foreground bg-muted px-1.5 py-0.5 rounded-full">{aiProviders.length}</span>
                )}
              </div>
              <Button
                size="sm"
                variant={showAddProvider ? "secondary" : "default"}
                onClick={() => { setShowAddProvider(!showAddProvider); setEditingProviderId(null); }}
                className="gap-1.5 h-8 text-xs"
              >
                <Plus className="h-3.5 w-3.5" />
                Add Provider
              </Button>
            </div>

            {/* Add provider form */}
            {showAddProvider && (
              <>
                <Separator />
                <div className="px-6 py-5 bg-muted/30">
                  <p className="text-sm font-medium text-foreground mb-4">New AI Provider</p>
                  <form onSubmit={handleAddProvider} className="space-y-4">
                    {/* Provider type + name */}
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                      <div className="space-y-1.5">
                        <Label className="text-xs">Provider <span className="text-destructive">*</span></Label>
                        <select
                          value={selectedPreset}
                          onChange={e => handlePresetChange(e.target.value)}
                          className="w-full h-9 rounded-md border border-input bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-1"
                        >
                          {Object.entries(PROVIDER_PRESETS).map(([k, p]) => (
                            <option key={k} value={k}>{p.label}</option>
                          ))}
                        </select>
                      </div>
                      <div className="space-y-1.5">
                        <Label className="text-xs">Display Name <span className="text-destructive">*</span></Label>
                        <Input value={newProviderName} onChange={e => setNewProviderName(e.target.value)} placeholder="My OpenAI" className="h-9 text-sm" />
                      </div>
                    </div>

                    {/* Base URL / Region */}
                    {selectedPreset === "bedrock" ? (
                      <div className="space-y-1.5">
                        <Label className="text-xs">AWS Region <span className="text-destructive">*</span></Label>
                        <select
                          value={newProviderCustomBaseUrl}
                          onChange={e => setNewProviderCustomBaseUrl(e.target.value)}
                          className="w-full h-9 rounded-md border border-input bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                        >
                          {BEDROCK_REGIONS.map(r => (
                            <option key={r.value} value={r.value}>{r.label} ({r.value})</option>
                          ))}
                        </select>
                      </div>
                    ) : selectedPreset === "custom" ? (
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                        <div className="space-y-1.5">
                          <Label className="text-xs">Base URL <span className="text-destructive">*</span></Label>
                          <Input type="url" value={newProviderCustomBaseUrl} onChange={e => setNewProviderCustomBaseUrl(e.target.value)} placeholder="https://your-api.com/v1" className="h-9 text-sm" />
                        </div>
                        <div className="space-y-1.5">
                          <Label className="text-xs">API Format <span className="text-destructive">*</span></Label>
                          <select
                            value={newProviderCustomType}
                            onChange={e => setNewProviderCustomType(e.target.value)}
                            className="w-full h-9 rounded-md border border-input bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                          >
                            <option value="openai-compatible">OpenAI-Compatible</option>
                            <option value="anthropic">Anthropic (Claude)</option>
                          </select>
                        </div>
                      </div>
                    ) : (
                      <div className="space-y-1.5">
                        <Label className="text-xs">Base URL <span className="text-muted-foreground">(auto-configured)</span></Label>
                        <div className="h-9 flex items-center px-3 rounded-md border border-input bg-muted text-sm text-muted-foreground font-mono truncate">
                          {currentPreset.baseUrl}
                        </div>
                      </div>
                    )}

                    {/* Credentials */}
                    {selectedPreset === "bedrock" ? (
                      <>
                        <div className="rounded-md bg-amber-50 border border-amber-200 px-3 py-2 text-xs text-amber-700 dark:bg-amber-950/30 dark:border-amber-800 dark:text-amber-400">
                          IAM credentials need <code className="font-mono">bedrock:InvokeModel</code> and <code className="font-mono">bedrock:Converse</code> permissions.
                        </div>
                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                          <div className="space-y-1.5">
                            <Label className="text-xs">Access Key ID <span className="text-destructive">*</span></Label>
                            <Input value={newProviderApiKey} onChange={e => setNewProviderApiKey(e.target.value)} placeholder="AKIAIOSFODNN7EXAMPLE" className="h-9 text-sm font-mono" />
                          </div>
                          <div className="space-y-1.5">
                            <Label className="text-xs">Secret Access Key <span className="text-destructive">*</span></Label>
                            <Input type="password" value={newProviderSecretKey} onChange={e => setNewProviderSecretKey(e.target.value)} placeholder="wJalrXUtnFEMI/K7MDENG/..." className="h-9 text-sm font-mono" />
                          </div>
                        </div>
                      </>
                    ) : (
                      <div className="space-y-1.5">
                        <Label className="text-xs">API Key <span className="text-destructive">*</span></Label>
                        <Input type="password" value={newProviderApiKey} onChange={e => setNewProviderApiKey(e.target.value)} placeholder="Your API key" className="h-9 text-sm font-mono" />
                      </div>
                    )}

                    {/* Model selection */}
                    <div className="space-y-2">
                      <Label className="text-xs">Models <span className="text-destructive">*</span></Label>

                      {currentPreset.suggestedModels.length > 0 && (
                        <div className="flex flex-wrap gap-1.5">
                          {currentPreset.suggestedModels.map(model => (
                            <button
                              key={model} type="button" onClick={() => toggleNewModel(model)}
                              className={cn(
                                "px-2.5 py-1 rounded-md text-xs font-mono border transition-all",
                                newSelectedModels.includes(model)
                                  ? "bg-primary/10 border-primary/40 text-primary"
                                  : "bg-background border-border text-muted-foreground hover:border-primary/30 hover:text-foreground"
                              )}
                            >
                              {newSelectedModels.includes(model) && "✓ "}{model}
                            </button>
                          ))}
                        </div>
                      )}

                      <div className="flex gap-2">
                        <Input
                          value={newCustomModelInput}
                          onChange={e => setNewCustomModelInput(e.target.value)}
                          onKeyDown={e => { if (e.key === "Enter") { e.preventDefault(); addNewCustomModel(); } }}
                          placeholder={currentPreset.suggestedModels.length > 0 ? "Add another model ID..." : "Enter model ID (e.g. gpt-4o)"}
                          className="h-8 text-xs font-mono"
                        />
                        <Button type="button" variant="outline" size="sm" className="h-8 text-xs shrink-0"
                          onClick={addNewCustomModel} disabled={!newCustomModelInput.trim()}>Add</Button>
                      </div>

                      {newSelectedModels.length > 0 && (
                        <div className="flex flex-wrap gap-1.5 pt-1">
                          <span className="text-[10px] text-muted-foreground self-center">Selected:</span>
                          {newSelectedModels.map(m => (
                            <span key={m} className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-primary/10 border border-primary/30 text-[11px] text-primary font-mono">
                              {m}
                              <button type="button" onClick={() => setNewSelectedModels(p => p.filter(x => x !== m))}
                                className="hover:text-destructive transition-colors">×</button>
                            </span>
                          ))}
                        </div>
                      )}
                    </div>

                    {providerTestResult && (
                      <AlertBanner success={providerTestResult.success} message={providerTestResult.message} />
                    )}
                    {providerFormError && <p className="text-sm text-destructive">{providerFormError}</p>}

                    <div className="flex items-center justify-between pt-1">
                      <Button type="button" variant="outline" size="sm" className="gap-1.5 h-8 text-xs"
                        onClick={handleTestNewProvider}
                        disabled={providerTestLoading || !newProviderApiKey || newSelectedModels.length === 0}>
                        {providerTestLoading ? <><Spinner className="h-3 w-3" /> Testing...</> : <><Zap className="h-3 w-3" /> Test Connection</>}
                      </Button>
                      <div className="flex gap-2">
                        <Button type="button" variant="ghost" size="sm" className="h-8 text-xs"
                          onClick={() => { setShowAddProvider(false); setProviderTestResult(null); setProviderFormError(null); }}>
                          Cancel
                        </Button>
                        <Button type="submit" size="sm" className="h-8 text-xs"
                          disabled={providerSubmitting || !newProviderName || newSelectedModels.length === 0 || !newProviderApiKey || (selectedPreset === "custom" && !newProviderCustomBaseUrl)}>
                          {providerSubmitting ? "Saving..." : "Save Provider"}
                        </Button>
                      </div>
                    </div>
                  </form>
                </div>
              </>
            )}

            <Separator />

            {/* Provider list */}
            <div className="p-4 space-y-2">
              {providersLoading ? (
                <div className="space-y-2 animate-pulse">
                  {[...Array(2)].map((_, i) => <div key={i} className="h-20 rounded-lg bg-muted" />)}
                </div>
              ) : aiProviders.length === 0 ? (
                <div className="py-10 text-center">
                  <div className="h-10 w-10 rounded-full bg-muted flex items-center justify-center mx-auto mb-3">
                    <Cpu className="h-5 w-5 text-muted-foreground" />
                  </div>
                  <p className="text-sm font-medium text-foreground mb-1">No providers configured</p>
                  <p className="text-xs text-muted-foreground">
                    Using <code className="px-1 rounded bg-muted font-mono">OPENAI_API_KEY</code> env var by default.
                    Add providers for Gemini, Claude, Groq, and more.
                  </p>
                </div>
              ) : (
                aiProviders.map((provider) => {
                  const isEditing = editingProviderId === provider.id;
                  const quickResult = quickTestResults[provider.id];

                  return (
                    <div
                      key={provider.id}
                      onClick={!provider.isDefault && !isEditing ? () => handleSetDefault(provider.id) : undefined}
                      className={cn(
                        "rounded-lg border p-4 transition-colors",
                        provider.isDefault
                          ? "border-primary/30 bg-primary/5"
                          : `border-border ${!isEditing ? "cursor-pointer hover:border-primary/20 hover:bg-accent/30" : ""}`
                      )}
                    >
                      {isEditing ? (
                        <div className="space-y-3">
                          <div className="flex items-center justify-between mb-1">
                            <span className="text-xs font-semibold text-foreground">Edit Provider</span>
                            <Button variant="ghost" size="sm" className="h-6 text-xs px-2"
                              onClick={() => { setEditingProviderId(null); setEditTestResult(null); }}>Cancel</Button>
                          </div>

                          <div className={cn("grid grid-cols-1 gap-3", provider.provider === "bedrock" ? "sm:grid-cols-3" : "sm:grid-cols-2")}>
                            <div className="space-y-1.5">
                              <Label className="text-xs">Name</Label>
                              <Input value={editProviderName} onChange={e => setEditProviderName(e.target.value)} className="h-8 text-xs" />
                            </div>
                            <div className="space-y-1.5">
                              <Label className="text-xs">{provider.provider === "bedrock" ? "Access Key ID" : "API Key"} <span className="text-muted-foreground">(masked = keep)</span></Label>
                              <Input value={editProviderApiKey} onChange={e => setEditProviderApiKey(e.target.value)} className="h-8 text-xs font-mono" />
                            </div>
                            {provider.provider === "bedrock" && (
                              <div className="space-y-1.5">
                                <Label className="text-xs">Secret Access Key</Label>
                                <Input type="password" value={editProviderSecretKey} onChange={e => setEditProviderSecretKey(e.target.value)} className="h-8 text-xs font-mono" />
                              </div>
                            )}
                          </div>

                          <div className="space-y-2">
                            <Label className="text-xs">Models</Label>
                            <div className="flex flex-wrap gap-1.5">
                              {editSelectedModels.map(m => (
                                <span key={m} className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-primary/10 border border-primary/30 text-[11px] text-primary font-mono">
                                  {m}
                                  <button type="button" onClick={() => toggleEditModel(m)} className="hover:text-destructive transition-colors">×</button>
                                </span>
                              ))}
                            </div>
                            <div className="flex gap-2">
                              <Input value={editCustomModelInput} onChange={e => setEditCustomModelInput(e.target.value)}
                                onKeyDown={e => { if (e.key === "Enter") { e.preventDefault(); addEditCustomModel(); } }}
                                placeholder="Add model ID..." className="h-8 text-xs font-mono" />
                              <Button type="button" variant="outline" size="sm" className="h-8 text-xs shrink-0"
                                onClick={addEditCustomModel} disabled={!editCustomModelInput.trim()}>Add</Button>
                            </div>
                          </div>

                          {editTestResult && (
                            <AlertBanner success={editTestResult.success} message={editTestResult.message} />
                          )}

                          <div className="flex items-center justify-between pt-1">
                            <Button type="button" variant="outline" size="sm" className="gap-1.5 h-7 text-xs"
                              onClick={() => handleTestEditProvider(provider)} disabled={editTestLoading}>
                              {editTestLoading ? <><Spinner className="h-3 w-3" /> Testing...</> : <><Zap className="h-3 w-3" /> Test</>}
                            </Button>
                            <Button size="sm" className="h-7 text-xs bg-emerald-600 hover:bg-emerald-500"
                              onClick={() => handleSaveEditProvider(provider.id)}
                              disabled={editSubmitting || editSelectedModels.length === 0 || !editProviderName}>
                              {editSubmitting ? "Saving..." : "Save Changes"}
                            </Button>
                          </div>
                        </div>
                      ) : (
                        <div className="flex items-start gap-3">
                          <div className={cn("h-2 w-2 rounded-full mt-2 shrink-0", provider.isDefault ? "bg-primary" : "bg-muted-foreground/30")} />
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2 mb-2 flex-wrap">
                              <span className="text-sm font-medium text-foreground">{provider.name}</span>
                              {provider.isDefault && (
                                <Badge variant="outline" className="text-[10px] h-4 px-1.5 bg-primary/10 text-primary border-primary/30">
                                  <Star className="h-2.5 w-2.5 mr-0.5" />
                                  Default
                                </Badge>
                              )}
                              <Badge variant="secondary" className="text-[10px] h-4 px-1.5">
                                {PROVIDER_TYPE_LABELS[provider.provider] || provider.provider}
                              </Badge>
                              {!provider.isDefault && (
                                <span className="text-[10px] text-muted-foreground">(click to set as default)</span>
                              )}
                            </div>
                            <div className="flex flex-wrap gap-1">
                              {(provider.models || []).map(m => (
                                <span key={m} className="text-[10px] px-1.5 py-0.5 rounded bg-muted text-muted-foreground font-mono border border-border/60">
                                  {m}
                                </span>
                              ))}
                            </div>
                            {quickResult && (
                              <div className={cn("flex items-center gap-1 text-xs mt-2", quickResult.success ? "text-emerald-600 dark:text-emerald-400" : "text-destructive")}>
                                {quickResult.success ? <CheckCircle2 className="h-3 w-3" /> : <XCircle className="h-3 w-3" />}
                                {quickResult.message}
                              </div>
                            )}
                          </div>
                          <div className="flex items-center gap-0.5 shrink-0">
                            <Button variant="ghost" size="icon" className="h-8 w-8" title="Test connection"
                              disabled={quickTestId === provider.id}
                              onClick={e => { e.stopPropagation(); handleQuickTest(provider); }}>
                              {quickTestId === provider.id ? <Spinner className="h-3.5 w-3.5" /> : <Zap className="h-3.5 w-3.5 text-muted-foreground" />}
                            </Button>
                            <Button variant="ghost" size="icon" className="h-8 w-8" title="Edit"
                              onClick={e => { e.stopPropagation(); startEditProvider(provider); setShowAddProvider(false); }}>
                              <Pencil className="h-3.5 w-3.5 text-muted-foreground" />
                            </Button>
                            <Button variant="ghost" size="icon" className="h-8 w-8 hover:text-destructive" title="Delete"
                              onClick={e => { e.stopPropagation(); handleDeleteProvider(provider.id); }}>
                              <Trash2 className="h-3.5 w-3.5" />
                            </Button>
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })
              )}
            </div>
          </Card>

          {/* Info note */}
          <div className="flex gap-3 p-4 rounded-lg border border-dashed text-sm text-muted-foreground">
            <Info className="h-4 w-4 shrink-0 mt-0.5" />
            <div className="space-y-1">
              <p>
                Add any provider supporting <strong className="text-foreground font-medium">OpenAI-compatible</strong> API
                (Gemini, Groq, Mistral, DeepSeek, Ollama) or <strong className="text-foreground font-medium">Anthropic</strong>&apos;s Messages API.
              </p>
              <p>
                The <strong className="text-foreground font-medium">default</strong> provider is used when no specific provider is chosen.
                Falls back to <code className="px-1 rounded bg-muted font-mono text-xs">OPENAI_API_KEY</code> if none configured.
              </p>
            </div>
          </div>
        </TabsContent>

        {/* ═══════════════ WEBHOOKS ═══════════════ */}
        <TabsContent value="webhooks" className="mt-5 space-y-5">
          <Card>
            <div className="px-6 py-4 border-b border-border flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Webhook className="h-4 w-4 text-muted-foreground" />
                <span className="text-sm font-semibold">Register Unipile Webhooks</span>
              </div>
              <Button variant="ghost" size="sm" className="h-7 gap-1.5 text-xs" onClick={fetchWebhooks} disabled={webhooksLoading}>
                <RefreshCw className={cn("h-3.5 w-3.5", webhooksLoading && "animate-spin")} />
                Refresh
              </Button>
            </div>
            <CardContent className="p-6 space-y-5">
              <p className="text-sm text-muted-foreground">
                Select which LinkedIn accounts should trigger the outreach webhooks (invite accepted &amp; message received). Leave all unchecked to apply to <strong className="text-foreground">all</strong> current and future accounts.
              </p>

              {/* App URL */}
              <div className="space-y-1.5">
                <Label className="text-xs font-medium">App URL</Label>
                <Input
                  value={appUrl}
                  onChange={e => setAppUrl(e.target.value)}
                  placeholder="https://your-app.vercel.app"
                  className="h-8 text-sm font-mono"
                />
                <p className="text-[11px] text-muted-foreground">
                  Webhook endpoint: <code className="px-1 rounded bg-muted">{appUrl}/api/webhooks/unipile</code>
                </p>
              </div>

              {/* Account selector */}
              <div className="space-y-1.5">
                <Label className="text-xs font-medium">Target Accounts (optional)</Label>
                {accountsLoading ? (
                  <p className="text-sm text-muted-foreground">Loading accounts…</p>
                ) : accounts.length === 0 ? (
                  <p className="text-sm text-muted-foreground">No Unipile accounts found. Add one in the Unipile Accounts tab first.</p>
                ) : (
                  <div className="rounded-lg border border-border divide-y divide-border">
                    {accounts.map(acc => {
                      const checked = webhookSelectedIds.has(acc.accountId);
                      return (
                        <label key={acc.id} className="flex items-center gap-3 px-4 py-2.5 hover:bg-muted/40 cursor-pointer">
                          <input
                            type="checkbox"
                            checked={checked}
                            onChange={e => {
                              setWebhookSelectedIds(prev => {
                                const next = new Set(prev);
                                if (e.target.checked) next.add(acc.accountId);
                                else next.delete(acc.accountId);
                                return next;
                              });
                            }}
                            className="h-3.5 w-3.5 accent-primary"
                          />
                          <div className="flex-1 min-w-0">
                            <p className="text-sm font-medium text-foreground truncate">{acc.name || acc.accountId}</p>
                            <p className="text-xs text-muted-foreground font-mono truncate">{acc.accountId}</p>
                          </div>
                          <span className={cn(
                            "text-xs px-2 py-0.5 rounded-full border font-medium",
                            STATUS_CONFIG[acc.status]?.badge ?? "bg-muted text-muted-foreground border-border",
                          )}>
                            {STATUS_CONFIG[acc.status]?.label ?? acc.status}
                          </span>
                        </label>
                      );
                    })}
                  </div>
                )}
                {webhookSelectedIds.size === 0 && accounts.length > 0 && (
                  <p className="text-[11px] text-amber-600 dark:text-amber-400">No accounts selected — webhooks will apply to ALL accounts.</p>
                )}
              </div>

              {webhookMsg && <AlertBanner success={webhookMsg.ok} message={webhookMsg.text} />}

              <Button
                onClick={handleRegisterWebhooks}
                disabled={webhookRegistering || !appUrl.trim()}
                className="gap-2"
              >
                {webhookRegistering ? <Spinner className="h-4 w-4" /> : <Zap className="h-4 w-4" />}
                {webhookRegistering ? "Registering…" : "Register Webhooks"}
              </Button>
            </CardContent>
          </Card>

          {/* Existing webhooks */}
          <Card>
            <div className="px-6 py-4 border-b border-border">
              <div className="flex items-center gap-2">
                <Webhook className="h-4 w-4 text-muted-foreground" />
                <span className="text-sm font-semibold">Registered Webhooks</span>
                {webhooks.length > 0 && (
                  <span className="text-xs px-1.5 py-0.5 rounded-full bg-muted text-muted-foreground font-semibold">{webhooks.length}</span>
                )}
              </div>
            </div>
            <CardContent className="p-0">
              {webhooksLoading ? (
                <div className="p-6 text-sm text-muted-foreground">Loading…</div>
              ) : webhooks.length === 0 ? (
                <div className="p-6 text-sm text-muted-foreground">No webhooks registered yet. Click &quot;Register Webhooks&quot; above.</div>
              ) : (
                <ul className="divide-y divide-border">
                  {webhooks.map((w, i) => {
                    const wid = w.id ?? w.webhook_id ?? String(i);
                    const isOurs = (w.request_url ?? w.url ?? "").includes("/api/webhooks/unipile");
                    return (
                      <li key={wid} className="flex items-center gap-3 px-5 py-3">
                        <div className="flex-1 min-w-0 space-y-0.5">
                          <div className="flex items-center gap-2">
                            <p className="text-sm font-medium text-foreground">{w.name || w.source || "Webhook"}</p>
                            <span className={cn(
                              "text-[10px] px-1.5 py-0.5 rounded-full font-semibold border",
                              w.enabled !== false
                                ? "bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-950/30 dark:text-emerald-400 dark:border-emerald-800"
                                : "bg-muted text-muted-foreground border-border",
                            )}>
                              {w.enabled !== false ? "Active" : "Disabled"}
                            </span>
                            {isOurs && (
                              <span className="text-[10px] px-1.5 py-0.5 rounded-full font-semibold border bg-blue-50 text-blue-700 border-blue-200 dark:bg-blue-950/30 dark:text-blue-400 dark:border-blue-800">
                                This app
                              </span>
                            )}
                          </div>
                          <p className="text-xs text-muted-foreground font-mono truncate">{w.request_url ?? w.url ?? "—"}</p>
                          <p className="text-[11px] text-muted-foreground">
                            Source: {w.source ?? "—"}
                            {w.account_ids?.length > 0 && ` · ${w.account_ids.length} account${w.account_ids.length !== 1 ? "s" : ""}`}
                            {(!w.account_ids || w.account_ids.length === 0) && " · All accounts"}
                          </p>
                        </div>
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-7 w-7 p-0 text-muted-foreground hover:text-destructive shrink-0"
                          onClick={() => handleDeleteWebhook(wid)}
                          title="Delete webhook"
                        >
                          <Trash className="h-3.5 w-3.5" />
                        </Button>
                      </li>
                    );
                  })}
                </ul>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        {/* ═══════════════ INTERVIEW ═══════════════ */}
        <TabsContent value="interview" className="mt-5 space-y-5">
          <Card>
            <div className="px-6 py-4 border-b border-border">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Video className="h-4 w-4 text-muted-foreground" />
                  <span className="text-sm font-semibold">Global Interview Questions</span>
                </div>
                <span className="text-xs text-muted-foreground">{interviewCfg.globalQuestions.length} question{interviewCfg.globalQuestions.length !== 1 ? "s" : ""}</span>
              </div>
              <p className="text-xs text-muted-foreground mt-1">
                These questions are asked in every interview regardless of role. Per-role questions are configured on each role&apos;s Interview tab.
              </p>
            </div>
            <CardContent className="p-5 space-y-3">
              {interviewCfgError && <AlertBanner success={false} message={interviewCfgError} />}
              {interviewCfgLoading ? (
                <div className="text-sm text-muted-foreground">Loading…</div>
              ) : interviewCfg.globalQuestions.length === 0 ? (
                <p className="text-sm text-muted-foreground">No global questions yet. Add one below.</p>
              ) : (
                <ul className="space-y-2">
                  {interviewCfg.globalQuestions.map((q, i) => (
                    <li key={q.id} className="flex items-start gap-3 rounded-lg border border-border bg-muted/30 px-3 py-2.5">
                      <span className="text-xs font-mono text-muted-foreground mt-0.5 shrink-0 w-4">{i + 1}.</span>
                      <div className="flex-1 min-w-0">
                        <p className="text-sm text-foreground">{q.text}</p>
                        {q.mustAsk && (
                          <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-amber-500/15 text-amber-600 dark:text-amber-400 border border-amber-500/30 font-medium">
                            Must ask
                          </span>
                        )}
                      </div>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-7 w-7 p-0 text-muted-foreground hover:text-destructive shrink-0"
                        onClick={() => removeGlobalQuestion(q.id)}
                        title="Remove question"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    </li>
                  ))}
                </ul>
              )}

              <Separator />

              <div className="space-y-2">
                <Label className="text-xs">Add global question</Label>
                <Input
                  placeholder="e.g. Tell me about yourself…"
                  value={newQuestionText}
                  onChange={e => setNewQuestionText(e.target.value)}
                  onKeyDown={e => { if (e.key === "Enter") { e.preventDefault(); addGlobalQuestion(); } }}
                />
                <div className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    id="mustAsk"
                    checked={newQuestionMust}
                    onChange={e => setNewQuestionMust(e.target.checked)}
                    className="h-3.5 w-3.5 accent-primary"
                  />
                  <label htmlFor="mustAsk" className="text-xs text-muted-foreground cursor-pointer">Must ask (agent cannot skip this question)</label>
                </div>
                <Button
                  onClick={addGlobalQuestion}
                  disabled={!newQuestionText.trim() || interviewCfgSaving}
                  variant="outline"
                  size="sm"
                  className="w-full gap-2"
                >
                  <Plus className="h-3.5 w-3.5" />
                  {interviewCfgSaving ? "Saving…" : interviewCfgSaved ? <><Check className="h-3 w-3" /> Saved</> : "Add Question"}
                </Button>
              </div>
            </CardContent>
          </Card>

          <Card>
            <div className="px-6 py-4 border-b border-border">
              <span className="text-sm font-semibold">Default Interview Message</span>
              <p className="text-xs text-muted-foreground mt-1">
                The org-wide message sent with the interview link, used for any role that doesn&apos;t set its own
                (job page → Interview tab). Variables: <code>{"{{firstName}}"}</code>, <code>{"{{name}}"}</code>,{" "}
                <code>{"{{role}}"}</code>, and the required <code>{INTERVIEW_LINK_TOKEN}</code>.
              </p>
            </div>
            <CardContent className="p-5 space-y-3">
              <div>
                <Label className="text-xs">Subject (email only)</Label>
                <Input
                  value={globalTemplateSubject}
                  onChange={e => setGlobalTemplateSubject(e.target.value)}
                  placeholder="Interview for the {{role}} role"
                  className="mt-1.5"
                />
              </div>
              <div>
                <div className="flex items-center justify-between">
                  <Label className="text-xs">Message body</Label>
                  <button
                    type="button"
                    onClick={insertInterviewLinkToken}
                    className="inline-flex items-center gap-1 text-[11px] text-primary hover:text-primary/80"
                  >
                    Insert interview link
                  </button>
                </div>
                <textarea
                  ref={interviewBodyRef}
                  value={globalTemplateBody}
                  onChange={e => setGlobalTemplateBody(e.target.value)}
                  rows={7}
                  placeholder={`Hi {{firstName}},\n\nWe'd love for you to take a short interview: ${INTERVIEW_LINK_TOKEN}`}
                  className="mt-1.5 w-full rounded-md border border-border bg-background p-2.5 font-mono text-xs"
                />
                <div className="flex items-center justify-between mt-1">
                  <p className="text-[11px] text-muted-foreground">
                    <code>{INTERVIEW_LINK_TOKEN}</code> is where each candidate&apos;s link is inserted. Leave blank to use the built-in default.
                  </p>
                  <div className="flex items-center gap-2">
                    {savedTemplate && (
                      <span className="text-[11px] text-emerald-600 dark:text-emerald-400 flex items-center gap-1">
                        <Check className="h-3 w-3" /> Saved
                      </span>
                    )}
                    <Button size="sm" className="h-7 text-xs" onClick={saveGlobalTemplate} disabled={savingTemplate || (!!globalTemplateBody.trim() && !globalTemplateHasLink)}>
                      {savingTemplate ? "Saving…" : "Save message"}
                    </Button>
                  </div>
                </div>
                {!!globalTemplateBody.trim() && !globalTemplateHasLink && (
                  <p className="text-[11px] text-destructive mt-1">
                    The message must include {INTERVIEW_LINK_TOKEN} — click “Insert interview link”.
                  </p>
                )}
              </div>
            </CardContent>
          </Card>

          <Card>
            <div className="px-6 py-4 border-b border-border">
              <span className="text-sm font-semibold">Agent Name</span>
              <p className="text-xs text-muted-foreground mt-1">The agent persona name sent to SCAI for all interviews.</p>
            </div>
            <CardContent className="p-5 space-y-3">
              <div className="flex items-center gap-3">
                <Input
                  value={interviewCfg.defaultAgentName}
                  onChange={e => setInterviewCfg(prev => ({ ...prev, defaultAgentName: e.target.value }))}
                  onBlur={() => saveInterviewCfg(interviewCfg)}
                  className="max-w-xs"
                />
                {interviewCfgSaved && (
                  <span className="text-xs text-emerald-600 dark:text-emerald-400 flex items-center gap-1">
                    <Check className="h-3 w-3" /> Saved
                  </span>
                )}
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        {/* ═══════════════ MY ACCOUNT ═══════════════ */}
        <TabsContent value="profile" className="mt-5">
          {/* Header row — identity + sign-out */}
          <div className="flex items-center justify-between mb-5">
            <div className="flex items-center gap-3">
              <div className="h-10 w-10 rounded-full bg-primary/10 flex items-center justify-center shrink-0">
                <UserCircle className="h-6 w-6 text-primary" />
              </div>
              <div>
                <p className="text-sm font-semibold leading-tight">
                  {(session?.user as any)?.name || session?.user?.email}
                </p>
                <p className="text-xs text-muted-foreground leading-tight">{session?.user?.email}</p>
              </div>
              {(session?.user as any)?.role && (
                <span className="text-[11px] px-2 py-0.5 rounded-full bg-primary/10 text-primary font-semibold uppercase tracking-wide">
                  {(session?.user as any).role}
                </span>
              )}
            </div>
            <Button
              variant="outline"
              size="sm"
              className="gap-2 text-muted-foreground hover:text-foreground"
              onClick={() => signOut({ callbackUrl: "/login" })}
            >
              <LogOut className="h-4 w-4" />
              Sign out
            </Button>
          </div>

          {/* Two-column grid matching other tabs */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">

            {/* ── Profile info ── */}
            <Card>
              <CardContent className="pt-5 space-y-4">
                <div>
                  <p className="text-sm font-semibold">Profile</p>
                  <p className="text-xs text-muted-foreground mt-0.5">Update your display name and email address.</p>
                </div>
                <Separator />

                <div className="space-y-1.5">
                  <Label htmlFor="profile-name">Display name</Label>
                  <Input
                    id="profile-name"
                    value={profileName}
                    onChange={e => setProfileName(e.target.value)}
                    placeholder="Your name"
                    disabled={isPendingProfile}
                  />
                </div>

                <div className="space-y-1.5">
                  <Label htmlFor="profile-email">Email address</Label>
                  <Input
                    id="profile-email"
                    type="email"
                    value={profileEmail}
                    onChange={e => setProfileEmail(e.target.value)}
                    placeholder="you@salescode.ai"
                    disabled={isPendingProfile}
                  />
                  <p className="text-xs text-muted-foreground">
                    Changing your email requires your current password and will sign you out.
                  </p>
                </div>

                {profileMsg && (
                  <p className={cn(
                    "text-sm font-medium",
                    profileMsg.ok ? "text-emerald-600 dark:text-emerald-400" : "text-destructive",
                  )}>
                    {profileMsg.text}
                  </p>
                )}

                <Button
                  className="w-full"
                  disabled={isPendingProfile}
                  onClick={() => {
                    setProfileMsg(null);
                    if (profileNewPw && profileNewPw !== profileConfirmPw) {
                      setProfileMsg({ ok: false, text: "New passwords don't match." });
                      return;
                    }
                    const changingEmail = profileEmail.toLowerCase().trim() !== (session?.user?.email ?? "").toLowerCase();
                    const changingPassword = !!profileNewPw;
                    const changingName = profileName.trim() !== ((session?.user as any)?.name ?? "");

                    if (!changingEmail && !changingPassword && !changingName) {
                      setProfileMsg({ ok: false, text: "Nothing has changed." });
                      return;
                    }

                    startProfileTransition(async () => {
                      const body: Record<string, string> = {};
                      if (changingName) body.name = profileName.trim();
                      if (changingEmail) body.email = profileEmail.toLowerCase().trim();
                      if (changingPassword) {
                        body.newPassword = profileNewPw;
                        body.currentPassword = profileCurrentPw;
                      } else if (changingEmail) {
                        body.currentPassword = profileCurrentPw;
                      }

                      const res = await fetch("/api/auth/profile", {
                        method: "PATCH",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify(body),
                      });
                      const data = await res.json();

                      if (!res.ok) {
                        setProfileMsg({ ok: false, text: data.error ?? "Update failed." });
                        return;
                      }

                      await updateSession({ name: data.user.name });
                      setProfileCurrentPw("");
                      setProfileNewPw("");
                      setProfileConfirmPw("");

                      if (data.requiresRelogin) {
                        setProfileMsg({ ok: true, text: "Saved. Signing you out so the new credentials take effect…" });
                        setTimeout(() => signOut({ callbackUrl: "/login" }), 2000);
                      } else {
                        setProfileMsg({ ok: true, text: "Profile updated." });
                      }
                    });
                  }}
                >
                  {isPendingProfile ? "Saving…" : "Save changes"}
                </Button>
              </CardContent>
            </Card>

            {/* ── Change password ── */}
            <Card>
              <CardContent className="pt-5 space-y-4">
                <div>
                  <p className="text-sm font-semibold">Change password</p>
                  <p className="text-xs text-muted-foreground mt-0.5">
                    Use a strong password with at least 8 characters.
                  </p>
                </div>
                <Separator />

                <div className="space-y-1.5">
                  <Label htmlFor="profile-current-pw">Current password</Label>
                  <div className="relative">
                    <Input id="profile-current-pw" type={showCurrentPw ? "text" : "password"} value={profileCurrentPw} onChange={e => setProfileCurrentPw(e.target.value)} placeholder="Enter your current password" disabled={isPendingProfile} autoComplete="current-password" className="pr-9" />
                    <button type="button" className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground" onClick={() => setShowCurrentPw(v => !v)} tabIndex={-1}>{showCurrentPw ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}</button>
                  </div>
                </div>

                <div className="space-y-1.5">
                  <Label htmlFor="profile-new-pw">New password</Label>
                  <div className="relative">
                    <Input id="profile-new-pw" type={showNewPw ? "text" : "password"} value={profileNewPw} onChange={e => setProfileNewPw(e.target.value)} placeholder="Min. 8 characters" disabled={isPendingProfile} autoComplete="new-password" className="pr-9" />
                    <button type="button" className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground" onClick={() => setShowNewPw(v => !v)} tabIndex={-1}>{showNewPw ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}</button>
                  </div>
                </div>

                <div className="space-y-1.5">
                  <Label htmlFor="profile-confirm-pw">Confirm new password</Label>
                  <div className="relative">
                    <Input id="profile-confirm-pw" type={showConfirmPw ? "text" : "password"} value={profileConfirmPw} onChange={e => setProfileConfirmPw(e.target.value)} placeholder="Repeat new password" disabled={isPendingProfile} autoComplete="new-password" className="pr-9" />
                    <button type="button" className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground" onClick={() => setShowConfirmPw(v => !v)} tabIndex={-1}>{showConfirmPw ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}</button>
                  </div>
                </div>

                <Button
                  variant="outline"
                  className="w-full"
                  disabled={isPendingProfile || !profileCurrentPw || !profileNewPw || !profileConfirmPw}
                  onClick={() => {
                    setProfileMsg(null);
                    if (profileNewPw !== profileConfirmPw) {
                      setProfileMsg({ ok: false, text: "New passwords don't match." });
                      return;
                    }
                    startProfileTransition(async () => {
                      const res = await fetch("/api/auth/profile", {
                        method: "PATCH",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({ currentPassword: profileCurrentPw, newPassword: profileNewPw }),
                      });
                      const data = await res.json();
                      if (!res.ok) {
                        setProfileMsg({ ok: false, text: data.error ?? "Update failed." });
                        return;
                      }
                      setProfileCurrentPw("");
                      setProfileNewPw("");
                      setProfileConfirmPw("");
                      setProfileMsg({ ok: true, text: "Password updated. Signing you out…" });
                      setTimeout(() => signOut({ callbackUrl: "/login" }), 2000);
                    });
                  }}
                >
                  {isPendingProfile ? "Updating…" : "Update password"}
                </Button>
              </CardContent>
            </Card>

          </div>

          {/* ── Team management (ADMIN only) ── */}
          {(session?.user as any)?.role === "ADMIN" && (
          <div className="mt-5 space-y-3">
            <div>
              <p className="text-sm font-semibold">Team management</p>
              <p className="text-xs text-muted-foreground mt-0.5">Only admins can see and manage team members.</p>
            </div>
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">

            {/* ── User list ── */}
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm font-semibold">Team members</p>
                  <p className="text-xs text-muted-foreground mt-0.5">{usersList.length} user{usersList.length !== 1 ? "s" : ""}</p>
                </div>
                <Button variant="outline" size="sm" className="gap-1.5 text-xs" onClick={fetchUsers} disabled={usersLoading}>
                  <RefreshCw className={cn("h-3.5 w-3.5", usersLoading && "animate-spin")} />
                  Refresh
                </Button>
              </div>

              {usersLoading ? (
                <div className="space-y-2">
                  {[1,2,3].map(i => <div key={i} className="h-16 rounded-xl bg-muted animate-pulse" />)}
                </div>
              ) : usersList.length === 0 ? (
                <div className="flex items-center justify-center h-32 rounded-xl border-2 border-dashed border-border/40 text-sm text-muted-foreground">
                  No users yet
                </div>
              ) : (
                <div className="space-y-2">
                  {usersList.map(u => (
                    <Card key={u.id} className={cn(editingUserId === u.id && "ring-2 ring-primary/30")}>
                      <CardContent className="py-3 px-4">
                        {editingUserId === u.id ? (
                          <div className="space-y-2">
                            <div className="flex items-center gap-2">
                              <Input
                                value={editUserName}
                                onChange={e => setEditUserName(e.target.value)}
                                placeholder="Display name"
                                className="h-8 text-sm flex-1"
                              />
                              <select
                                value={editUserRole}
                                onChange={e => setEditUserRole(e.target.value)}
                                className="h-8 rounded-md border border-input bg-background px-2 text-sm focus:outline-none focus:ring-1 focus:ring-ring"
                              >
                                <option value="RECRUITER">RECRUITER</option>
                                <option value="ADMIN">ADMIN</option>
                                <option value="VIEWER">VIEWER</option>
                              </select>
                            </div>
                            <Input
                              type="password"
                              value={editUserPassword}
                              onChange={e => setEditUserPassword(e.target.value)}
                              placeholder="New password (leave blank to keep current)"
                              className="h-8 text-sm"
                            />
                            <div className="flex gap-2 pt-1">
                              <Button size="sm" className="h-7 text-xs gap-1" onClick={async () => {
                                const body: Record<string, string> = { name: editUserName, role: editUserRole };
                                if (editUserPassword) body.password = editUserPassword;
                                const res = await fetch(`/api/auth/users/${u.id}`, {
                                  method: "PATCH",
                                  headers: { "Content-Type": "application/json" },
                                  body: JSON.stringify(body),
                                });
                                if (res.ok) { setEditingUserId(null); setEditUserPassword(""); fetchUsers(); }
                                else {
                                  const d = await res.json();
                                  setUserFormMsg({ ok: false, text: d.error ?? "Update failed." });
                                }
                              }}>
                                <Check className="h-3 w-3" /> Save
                              </Button>
                              <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => { setEditingUserId(null); setEditUserPassword(""); }}>
                                Cancel
                              </Button>
                            </div>
                          </div>
                        ) : (
                          <div className="flex items-center gap-3">
                            <div className="h-8 w-8 rounded-full bg-primary/10 flex items-center justify-center shrink-0 text-xs font-bold text-primary">
                              {(u.name || u.email).slice(0, 1).toUpperCase()}
                            </div>
                            <div className="flex-1 min-w-0">
                              <p className="text-sm font-medium truncate">{u.name || <span className="text-muted-foreground italic">No name</span>}</p>
                              <p className="text-xs text-muted-foreground truncate">{u.email}</p>
                            </div>
                            <span className={cn(
                              "text-[10px] font-bold px-2 py-0.5 rounded-full uppercase tracking-wide shrink-0",
                              u.role === "ADMIN" ? "bg-amber-500/10 text-amber-600 dark:text-amber-400" :
                              u.role === "VIEWER" ? "bg-muted text-muted-foreground" :
                              "bg-primary/10 text-primary"
                            )}>
                              {u.role}
                            </span>
                            <button
                              className="h-7 w-7 rounded-md flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity text-muted-foreground hover:text-foreground hover:bg-muted"
                              onClick={() => { setEditingUserId(u.id); setEditUserRole(u.role); setEditUserName(u.name ?? ""); setEditUserPassword(""); }}
                              title="Edit"
                            >
                              <Pencil className="h-3.5 w-3.5" />
                            </button>
                            <button
                              className="h-7 w-7 rounded-md flex items-center justify-center text-muted-foreground hover:text-destructive hover:bg-destructive/10"
                              title="Delete user"
                              onClick={async () => {
                                if (!confirm(`Delete ${u.email}? This cannot be undone.`)) return;
                                const res = await fetch(`/api/auth/users/${u.id}`, { method: "DELETE" });
                                if (res.ok) fetchUsers();
                                else {
                                  const d = await res.json();
                                  setUserFormMsg({ ok: false, text: d.error ?? "Delete failed." });
                                }
                              }}
                            >
                              <Trash2 className="h-3.5 w-3.5" />
                            </button>
                          </div>
                        )}
                      </CardContent>
                    </Card>
                  ))}
                </div>
              )}
            </div>

            {/* ── Add new user ── */}
            <Card>
              <CardContent className="pt-5 space-y-4">
                <div>
                  <p className="text-sm font-semibold">Add team member</p>
                  <p className="text-xs text-muted-foreground mt-0.5">New users can sign in immediately after creation.</p>
                </div>
                <Separator />

                <div className="space-y-1.5">
                  <Label htmlFor="new-user-name">Full name</Label>
                  <Input
                    id="new-user-name"
                    value={newUserName}
                    onChange={e => setNewUserName(e.target.value)}
                    placeholder="Jane Smith"
                    disabled={creatingUser}
                  />
                </div>

                <div className="space-y-1.5">
                  <Label htmlFor="new-user-email">Email address</Label>
                  <Input
                    id="new-user-email"
                    type="email"
                    value={newUserEmail}
                    onChange={e => setNewUserEmail(e.target.value)}
                    placeholder="jane@salescode.ai"
                    disabled={creatingUser}
                  />
                </div>

                <div className="space-y-1.5">
                  <Label htmlFor="new-user-password">Password</Label>
                  <div className="relative">
                    <Input id="new-user-password" type={showNewUserPw ? "text" : "password"} value={newUserPassword} onChange={e => setNewUserPassword(e.target.value)} placeholder="Min. 8 characters" disabled={creatingUser} className="pr-9" />
                    <button type="button" className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground" onClick={() => setShowNewUserPw(v => !v)} tabIndex={-1}>{showNewUserPw ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}</button>
                  </div>
                </div>

                <div className="space-y-1.5">
                  <Label htmlFor="new-user-role">Role</Label>
                  <select
                    id="new-user-role"
                    value={newUserRole}
                    onChange={e => setNewUserRole(e.target.value)}
                    disabled={creatingUser}
                    className="w-full h-9 rounded-md border border-input bg-background px-3 text-sm focus:outline-none focus:ring-1 focus:ring-ring disabled:opacity-50"
                  >
                    <option value="RECRUITER">Recruiter — can manage jobs, candidates, outreach</option>
                    <option value="ADMIN">Admin — can manage users + all Recruiter access</option>
                    <option value="VIEWER">Viewer — read-only (future)</option>
                  </select>
                  <p className="text-xs text-muted-foreground">
                    {newUserRole === "ADMIN" && "Full access including user management."}
                    {newUserRole === "RECRUITER" && "Standard recruiter access — cannot manage team members."}
                    {newUserRole === "VIEWER" && "Read-only access. Active in a future release."}
                  </p>
                </div>

                {userFormMsg && (
                  <p className={cn(
                    "text-sm font-medium",
                    userFormMsg.ok ? "text-emerald-600 dark:text-emerald-400" : "text-destructive",
                  )}>
                    {userFormMsg.text}
                  </p>
                )}

                <Button
                  className="w-full gap-2"
                  disabled={creatingUser || !newUserEmail || !newUserPassword}
                  onClick={async () => {
                    setUserFormMsg(null);
                    setCreatingUser(true);
                    try {
                      const res = await fetch("/api/auth/users", {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({
                          email: newUserEmail,
                          name: newUserName,
                          password: newUserPassword,
                          role: newUserRole,
                        }),
                      });
                      const data = await res.json();
                      if (!res.ok) {
                        setUserFormMsg({ ok: false, text: data.error ?? "Failed to create user." });
                        return;
                      }
                      setUserFormMsg({ ok: true, text: `${data.user.email} added successfully.` });
                      setNewUserEmail("");
                      setNewUserName("");
                      setNewUserPassword("");
                      setNewUserRole("RECRUITER");
                      fetchUsers();
                    } finally {
                      setCreatingUser(false);
                    }
                  }}
                >
                  <Plus className="h-4 w-4" />
                  {creatingUser ? "Creating…" : "Create user"}
                </Button>
              </CardContent>
            </Card>

            </div>
          </div>
          )}

        </TabsContent>

      </Tabs>
    </div>
  );
}
