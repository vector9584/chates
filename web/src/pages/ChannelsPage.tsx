import { useCallback, useEffect, useLayoutEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  Bot,
  Check,
  CheckCircle2,
  ExternalLink,
  Info,
  PlugZap,
  QrCode,
  Radio,
  RotateCw,
  Save,
  Settings2,
  WifiOff,
  X,
} from "lucide-react";
import * as QRCode from "qrcode";
import { Badge } from "@nous-research/ui/ui/components/badge";
import { Button } from "@nous-research/ui/ui/components/button";
import { Card, CardContent } from "@nous-research/ui/ui/components/card";
import { Input } from "@nous-research/ui/ui/components/input";
import { Label } from "@nous-research/ui/ui/components/label";
import { Spinner } from "@nous-research/ui/ui/components/spinner";
import { Switch } from "@nous-research/ui/ui/components/switch";
import { Toast } from "@nous-research/ui/ui/components/toast";
import { useToast } from "@nous-research/ui/hooks/use-toast";
import { api } from "@/lib/api";
import type {
  MessagingPlatform,
  MessagingPlatformEnvVar,
  MessagingPlatformUpdate,
  TelegramOnboardingStartResponse,
  WhatsAppOnboardingStartResponse,
} from "@/lib/api";
import { useModalBehavior } from "@/hooks/useModalBehavior";
import { usePageHeader } from "@/contexts/usePageHeader";
import { cn, themedBody } from "@/lib/utils";

// State → badge mapping. The backend emits a small, fixed vocabulary plus
// whatever the live gateway runtime reports (connected/disconnected/fatal).
const STATE_BADGE: Record<
  string,
  { tone: "success" | "warning" | "destructive" | "secondary" | "outline"; label: string }
> = {
  connected: { tone: "success", label: "已连接" },
  pending_restart: { tone: "warning", label: "重启后生效" },
  gateway_stopped: { tone: "warning", label: "网关已停止" },
  startup_failed: { tone: "destructive", label: "启动失败" },
  disconnected: { tone: "warning", label: "已断开" },
  not_configured: { tone: "outline", label: "未配置" },
  disabled: { tone: "secondary", label: "已禁用" },
  fatal: { tone: "destructive", label: "错误" },
};

function stateBadge(state: string) {
  return STATE_BADGE[state] ?? { tone: "outline" as const, label: state };
}

const TELEGRAM_USER_ID_RE = /^\d+$/;
const TELEGRAM_BOT_TOKEN_RE = /^\d+:[A-Za-z0-9_-]{30,}$/;
const SLACK_MEMBER_ID_RE = /^[UW][A-Z0-9]{2,}$/;
const SLACK_TOKEN_PREFIXES: Record<string, string> = {
  SLACK_BOT_TOKEN: "xoxb-",
  SLACK_APP_TOKEN: "xapp-",
};

function validateMessagingEnvField(field: MessagingPlatformEnvVar, value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;

  if (field.key === "TELEGRAM_BOT_TOKEN" && !TELEGRAM_BOT_TOKEN_RE.test(trimmed)) {
    return "请粘贴 @BotFather 提供的完整令牌（例如 123456789:ABC…）。";
  }

  if (field.key === "TELEGRAM_ALLOWED_USERS") {
    const invalid = trimmed
      .split(",")
      .map((part) => part.trim())
      .filter(Boolean)
      .find((part) => !TELEGRAM_USER_ID_RE.test(part));
    if (invalid) {
      return `${invalid} 不是数字形式的 Telegram 用户 ID。`;
    }
  }

  const expectedPrefix = SLACK_TOKEN_PREFIXES[field.key];
  if (expectedPrefix && !trimmed.startsWith(expectedPrefix)) {
    return `${field.prompt || field.key} 必须以 ${expectedPrefix} 开头`;
  }

  if (field.key === "SLACK_ALLOWED_USERS") {
    // Mirror the gateway's parse (gateway/platforms/slack.py): drop empty
    // entries so a trailing/interior comma isn't rejected here. "*" is the
    // allow-all wildcard the gateway honors.
    const parts = trimmed
      .split(",")
      .map((part) => part.trim())
      .filter(Boolean);
    const invalid = parts.find((part) => part !== "*" && !SLACK_MEMBER_ID_RE.test(part));
    if (invalid) {
      return `${invalid} 看起来不是有效的 Slack 成员 ID。请使用类似 U01ABC2DEF3 的 ID。`;
    }
  }

  return null;
}

function formatExpiry(expiresAt: string): string {
  const ms = Date.parse(expiresAt) - Date.now();
  if (!Number.isFinite(ms) || ms <= 0) return "已过期";
  const seconds = Math.ceil(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return `${minutes}:${rest.toString().padStart(2, "0")}`;
}

function isTerminalTelegramOnboardingError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /\b410\b/.test(message) && /\b(expired|claimed|gone)\b/i.test(message);
}

function isTerminalWhatsAppOnboardingError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /\b410\b/.test(message) && /\b(expired|gone)\b/i.test(message);
}

function normalizeWhatsAppMode(mode: unknown): "bot" | "self-chat" | null {
  return mode === "bot" || mode === "self-chat" ? mode : null;
}

export default function ChannelsPage() {
  const [platforms, setPlatforms] = useState<MessagingPlatform[]>([]);
  const [envPath, setEnvPath] = useState("~/.hermes/.env");
  const [gatewayStartCommand, setGatewayStartCommand] = useState(
    "hermes gateway start",
  );
  const [loading, setLoading] = useState(true);
  const { toast, showToast } = useToast();
  const { setEnd } = usePageHeader();

  // Config modal state
  const [editing, setEditing] = useState<MessagingPlatform | null>(null);
  const [draftEnv, setDraftEnv] = useState<Record<string, string>>({});
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const closeEdit = useCallback(() => {
    setEditing(null);
    setFieldErrors({});
  }, []);
  const editModalRef = useModalBehavior({ open: editing !== null, onClose: closeEdit });

  // Per-card busy + restart-needed tracking
  const [togglingId, setTogglingId] = useState<string | null>(null);
  const [testingId, setTestingId] = useState<string | null>(null);
  const [restartNeeded, setRestartNeeded] = useState(false);
  const [restarting, setRestarting] = useState(false);

  const gatewayRunning = platforms.length > 0 && platforms[0].gateway_running;

  const load = useCallback(() => {
    return api
      .getMessagingPlatforms()
      .then((res) => {
        setPlatforms(res.platforms);
        setEnvPath(res.env_path || "~/.hermes/.env");
        setGatewayStartCommand(res.gateway_start_command || "hermes gateway start");
      })
      .catch((e) => showToast(`错误：${e}`, "error"));
  }, [showToast]);

  useEffect(() => {
    load().finally(() => setLoading(false));
  }, [load]);

  const openConfig = (platform: MessagingPlatform) => {
    const initial: Record<string, string> = {};
    platform.env_vars.forEach((v) => {
      initial[v.key] = "";
    });
    setDraftEnv(initial);
    setFieldErrors({});
    setEditing(platform);
  };

  const handleSave = async () => {
    if (!editing) return;
    // Only send fields the user actually filled in — leaving a field blank
    // preserves the existing value rather than clobbering it.
    const env: Record<string, string> = {};
    Object.entries(draftEnv).forEach(([k, v]) => {
      if (v.trim()) env[k] = v.trim();
    });
    if (Object.keys(env).length === 0) {
      showToast("没有可保存的内容 — 请至少填写一个字段。", "error");
      return;
    }
    const missing = editing.env_vars.filter(
      (v) => v.required && !v.is_set && !env[v.key],
    );
    if (missing.length > 0) {
      showToast(`${missing[0].prompt || missing[0].key} 为必填项`, "error");
      return;
    }
    const nextFieldErrors: Record<string, string> = {};
    editing.env_vars.forEach((field) => {
      const message = validateMessagingEnvField(field, draftEnv[field.key] || "");
      if (message) nextFieldErrors[field.key] = message;
    });
    if (Object.keys(nextFieldErrors).length > 0) {
      setFieldErrors(nextFieldErrors);
      showToast("保存前请先修复高亮字段。", "error");
      return;
    }
    setSaving(true);
    try {
      const body: MessagingPlatformUpdate = { env, enabled: true };
      await api.updateMessagingPlatform(editing.id, body);
      showToast(`${editing.name} 已保存`, "success");
      setEditing(null);
      setRestartNeeded(true);
      await load();
    } catch (e) {
      showToast(`保存失败：${e}`, "error");
    } finally {
      setSaving(false);
    }
  };

  const handleToggle = async (platform: MessagingPlatform) => {
    const next = !platform.enabled;
    setTogglingId(platform.id);
    try {
      await api.updateMessagingPlatform(platform.id, { enabled: next });
      setPlatforms((prev) =>
        prev.map((p) =>
          p.id === platform.id
            ? { ...p, enabled: next, state: next ? "pending_restart" : "disabled" }
            : p,
        ),
      );
      setRestartNeeded(true);
    } catch (e) {
      showToast(`错误：${e}`, "error");
    } finally {
      setTogglingId(null);
    }
  };

  const handleTest = async (platform: MessagingPlatform) => {
    setTestingId(platform.id);
    try {
      const res = await api.testMessagingPlatform(platform.id);
      showToast(`${platform.name}: ${res.message}`, res.ok ? "success" : "error");
    } catch (e) {
      showToast(`错误：${e}`, "error");
    } finally {
      setTestingId(null);
    }
  };

  const handleRestart = async () => {
    setRestarting(true);
    try {
      await api.restartGateway();
      showToast("网关正在重启…", "success");
      setRestartNeeded(false);
      // Give the gateway a moment to come up, then refresh status.
      setTimeout(() => void load(), 4000);
    } catch (e) {
      showToast(`重启失败：${e}`, "error");
    } finally {
      setRestarting(false);
    }
  };

  useLayoutEffect(() => {
    setEnd(
      <Button
        className="uppercase"
        size="sm"
        onClick={handleRestart}
        disabled={restarting}
        prefix={restarting ? <Spinner /> : <RotateCw className="h-4 w-4" />}
      >
        {restarting ? "重启中…" : "重启网关"}
      </Button>,
    );
    return () => setEnd(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [setEnd, restarting]);

  const configured = useMemo(
    () => platforms.filter((p) => p.configured).length,
    [platforms],
  );

  if (loading) {
    return (
      <div className="flex items-center justify-center py-24">
        <Spinner className="text-2xl text-primary" />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <Toast toast={toast} />

      {/* Restart banner */}
      {restartNeeded && (
        <Card className="border-warning/50">
          <CardContent className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex items-center gap-2 text-sm">
              <AlertTriangle className="h-4 w-4 shrink-0 text-warning" />
              <span>
                更改已保存。重启网关后才会生效。
              </span>
            </div>
            <Button
              size="sm"
              className="uppercase shrink-0"
              onClick={handleRestart}
              disabled={restarting}
              prefix={restarting ? <Spinner /> : <RotateCw className="h-4 w-4" />}
            >
              {restarting ? "重启中…" : "立即重启"}
            </Button>
          </CardContent>
        </Card>
      )}

      {!gatewayRunning && !restartNeeded && (
        <Card className="border-border">
          <CardContent className="flex items-center gap-2 p-4 text-sm text-muted-foreground">
            <WifiOff className="h-4 w-4 shrink-0" />
            <span>
              网关未运行。请在此配置渠道，然后使用{" "}
              <code className="font-courier">{gatewayStartCommand}</code>{" "}
              启动网关（或使用上方的“重启”按钮）。
            </span>
          </CardContent>
        </Card>
      )}

      <p className="text-xs text-muted-foreground">
        已配置 {configured} / {platforms.length} 个渠道。凭据将写入{" "}
        <code className="font-courier">{envPath}</code>；网关会在下次重启时连接每个已启用的渠道。
      </p>

      {/* Config modal */}
      {editing && (
        <div
          ref={editModalRef}
          className={cn(
            "fixed inset-0 z-[100] flex min-h-dvh items-start justify-center overflow-y-auto bg-background/85 px-4",
            "pb-[calc(1rem+env(safe-area-inset-bottom))] pt-[calc(1rem+env(safe-area-inset-top))]",
            "sm:items-center sm:p-4",
          )}
          onClick={(e) => e.target === e.currentTarget && setEditing(null)}
          role="dialog"
          aria-modal="true"
          aria-labelledby="channel-config-title"
        >
          <div
            className={cn(
              themedBody,
              "relative flex max-h-[calc(100dvh-2rem)] w-full max-w-lg flex-col border border-border bg-card shadow-2xl sm:max-h-[90dvh]",
            )}
          >
            <Button
              ghost
              size="icon"
              onClick={() => setEditing(null)}
              className="absolute right-2 top-2 text-muted-foreground hover:text-foreground"
              aria-label="关闭"
            >
              <X />
            </Button>

            <header className="p-5 pb-3 border-b border-border">
              <h2
                id="channel-config-title"
                className="font-mondwest text-display text-base tracking-wider"
              >
                {editing.id === "telegram"
                  ? "使用你自己的 Telegram 机器人"
                  : `配置 ${editing.name}`}
              </h2>
              {editing.docs_url && (
                <a
                  href={editing.docs_url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="mt-1 inline-flex items-center gap-1 text-xs text-primary hover:underline"
                >
                  {editing.id === "telegram" ? "BotFather 指南" : "设置指南"}
                  <ExternalLink className="h-3 w-3" />
                </a>
              )}
            </header>

            <div className="grid gap-4 overflow-y-auto overscroll-contain p-4 sm:p-5">
              {editing.id === "telegram" && (
                <div className="grid gap-3 text-sm text-muted-foreground">
                  <p>
                    连接一个你已经拥有的机器人，或在填写此表单前先在 Telegram 中创建一个。
                  </p>
                  <ol className="grid list-decimal gap-1.5 pl-5">
                    <li>
                      打开 <span className="text-foreground">@BotFather</span>，发送
                      <code className="mx-1 font-courier text-xs">/newbot</code>，并
                      按照提示操作。
                    </li>
                    <li>复制 BotFather 给你的完整机器人令牌。</li>
                    <li>
                      给 <span className="text-foreground">@userinfobot</span> 发消息以
                      获取你的数字 Telegram 用户 ID，然后在下方添加它以
                      立即获得访问权限。
                    </li>
                  </ol>
                  <div className="flex flex-wrap gap-x-4 gap-y-2 text-xs">
                    <a
                      href="https://t.me/BotFather"
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-1 text-primary hover:underline"
                    >
                      打开 @BotFather <ExternalLink className="h-3 w-3" />
                    </a>
                    <a
                      href="https://t.me/userinfobot"
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-1 text-primary hover:underline"
                    >
                      查找我的用户 ID <ExternalLink className="h-3 w-3" />
                    </a>
                  </div>
                  <p className="text-xs">
                    你可以将允许的用户留空。届时 Hermes 会向新的私信用户发送一个代码，由你在配对页面批准。
                  </p>
                </div>
              )}
              <p className="text-xs text-muted-foreground">
                {editing.description}
              </p>
              {editing.env_vars.map((field: MessagingPlatformEnvVar) => (
                <div className="grid gap-1.5" key={field.key}>
                  <div className="flex items-center gap-1.5">
                    <Label htmlFor={`field-${field.key}`}>
                      {field.prompt || field.key}
                      {field.required ? " *" : ""}
                    </Label>
                    {field.help && (
                      <span
                        aria-label={field.help}
                        className="inline-flex text-muted-foreground hover:text-foreground"
                        role="img"
                        title={field.help}
                      >
                        <Info className="h-3.5 w-3.5" />
                      </span>
                    )}
                  </div>
                  {field.description && (
                    <span className="text-xs text-muted-foreground">
                      {field.description}
                    </span>
                  )}
                  <Input
                    id={`field-${field.key}`}
                    type={field.is_password ? "password" : "text"}
                    className="text-base leading-6 sm:text-xs sm:leading-4"
                    placeholder={
                      field.is_set
                        ? field.redacted_value || "••••••（已设置 — 留空则保持不变）"
                        : field.key
                    }
                    value={draftEnv[field.key] ?? ""}
                    aria-invalid={Boolean(fieldErrors[field.key])}
                    onChange={(e) => {
                      const nextValue = e.target.value;
                      setDraftEnv((prev) => ({ ...prev, [field.key]: nextValue }));
                      setFieldErrors((prev) => {
                        if (!prev[field.key]) return prev;
                        const next = { ...prev };
                        delete next[field.key];
                        return next;
                      });
                    }}
                  />
                  {fieldErrors[field.key] && (
                    <span className="text-xs text-destructive">
                      {fieldErrors[field.key]}
                    </span>
                  )}
                </div>
              ))}

              <div className="flex flex-col-reverse gap-2 pt-1 sm:flex-row sm:justify-end">
                <Button
                  ghost
                  size="sm"
                  className="w-full sm:w-auto"
                  onClick={() => setEditing(null)}
                >
                  取消
                </Button>
                <Button
                  className="w-full uppercase sm:w-auto"
                  size="sm"
                  onClick={handleSave}
                  disabled={saving}
                  prefix={saving ? <Spinner /> : undefined}
                >
                  {saving ? "保存中…" : "保存并启用"}
                </Button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Platform list */}
      <div className="grid gap-3">
        {platforms.map((platform) => {
          const badge = stateBadge(platform.state);
          const busy = togglingId === platform.id;
          const StateIcon =
            platform.state === "connected"
              ? CheckCircle2
              : platform.state === "fatal" || platform.state === "startup_failed"
                ? AlertTriangle
                : Radio;
          return (
            <Card key={platform.id} className="border-border">
              <CardContent className="flex flex-col gap-4 p-4">
                <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                  <div className="flex items-start gap-3 min-w-0">
                    <StateIcon
                      className={cn(
                        "h-5 w-5 shrink-0 mt-0.5",
                        platform.state === "connected"
                          ? "text-success"
                          : platform.state === "fatal" ||
                              platform.state === "startup_failed"
                            ? "text-destructive"
                            : "text-muted-foreground",
                      )}
                    />
                    <div className="flex flex-col gap-0.5 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="font-mondwest normal-case text-sm font-medium">
                          {platform.name}
                        </span>
                        <Badge tone={badge.tone}>{badge.label}</Badge>
                      </div>
                      <span className="text-xs text-muted-foreground">
                        {platform.description}
                      </span>
                      {platform.error_message && (
                        <span className="text-xs text-destructive">
                          {platform.error_message}
                        </span>
                      )}
                    </div>
                  </div>

                  <div className="flex items-center gap-2 shrink-0 self-start sm:self-center">
                    <div className="flex items-center gap-1.5">
                      {busy ? (
                        <Spinner className="text-sm" />
                      ) : (
                        <Switch
                          checked={platform.enabled}
                          onCheckedChange={() => void handleToggle(platform)}
                          aria-label={`启用 ${platform.name}`}
                        />
                      )}
                    </div>
                    <Button
                      ghost
                      size="sm"
                      onClick={() => handleTest(platform)}
                      disabled={testingId === platform.id}
                      prefix={
                        testingId === platform.id ? (
                          <Spinner />
                        ) : (
                          <PlugZap className="h-4 w-4" />
                        )
                      }
                    >
                      测试
                    </Button>
                    {platform.id !== "telegram" && (
                      <Button
                        size="sm"
                        className="uppercase"
                        onClick={() => openConfig(platform)}
                        prefix={<Settings2 className="h-4 w-4" />}
                      >
                        配置
                      </Button>
                    )}
                  </div>
                </div>
                {platform.id === "telegram" && (
                  <TelegramOnboardingPanel
                    onManualSetup={() => openConfig(platform)}
                    onChanged={load}
                    onRestartNeeded={() => setRestartNeeded(true)}
                    platform={platform}
                    setRestartNeeded={setRestartNeeded}
                    showToast={showToast}
                  />
                )}
                {platform.id === "whatsapp" && (
                  <WhatsAppOnboardingPanel
                    onChanged={load}
                    onRestartNeeded={() => setRestartNeeded(true)}
                    platform={platform}
                    setRestartNeeded={setRestartNeeded}
                    showToast={showToast}
                  />
                )}
              </CardContent>
            </Card>
          );
        })}
      </div>
    </div>
  );
}

function WhatsAppOnboardingPanel({
  onChanged,
  onRestartNeeded,
  platform,
  setRestartNeeded,
  showToast,
}: {
  onChanged: () => Promise<void>;
  onRestartNeeded: () => void;
  platform: MessagingPlatform;
  setRestartNeeded: (needed: boolean) => void;
  showToast: (message: string, type: "success" | "error") => void;
}) {
  const configuredMode = useMemo(
    () => normalizeWhatsAppMode(platform.whatsapp_setup?.mode),
    [platform.whatsapp_setup?.mode],
  );
  const [setup, setSetup] = useState<WhatsAppOnboardingStartResponse | null>(
    null,
  );
  const [qrDataUrl, setQrDataUrl] = useState("");
  const [phase, setPhase] = useState<
    "idle" | "starting" | "waiting" | "connected" | "applying"
  >("idle");
  const [mode, setMode] = useState<"bot" | "self-chat">(
    configuredMode ?? "bot",
  );
  const [allowedUsers, setAllowedUsers] = useState("");
  const [error, setError] = useState("");
  const [tick, setTick] = useState(0);

  useEffect(() => {
    if (!setup && phase === "idle" && configuredMode) {
      setMode(configuredMode);
    }
  }, [configuredMode, phase, setup]);

  const updateQr = useCallback(async (payload?: string | null) => {
    if (!payload) return;
    const dataUrl = await QRCode.toDataURL(payload, {
      errorCorrectionLevel: "M",
      margin: 3,
      width: 240,
    });
    setQrDataUrl(dataUrl);
  }, []);

  useEffect(() => {
    if (!setup || phase !== "waiting") return;
    let cancelled = false;
    let timeout: ReturnType<typeof setTimeout> | null = null;

    const poll = async () => {
      try {
        const status = await api.getWhatsAppOnboardingStatus(setup.pairing_id);
        if (cancelled) return;
        setSetup(status);
        if (status.qr_payload && status.qr_payload !== setup.qr_payload) {
          await updateQr(status.qr_payload);
        }
        if (cancelled) return;
        if (status.status === "connected") {
          setPhase("connected");
          setError("");
          return;
        }
        if (status.status === "error") {
          setError(status.error || "WhatsApp 设置失败。");
          setSetup(null);
          setQrDataUrl("");
          setPhase("idle");
          return;
        }
        setError("");
        timeout = setTimeout(poll, 1500);
      } catch (pollError) {
        if (cancelled) return;
        const expiresAt = Date.parse(setup.expires_at);
        const expired =
          Number.isFinite(expiresAt) && Date.now() >= expiresAt;
        if (isTerminalWhatsAppOnboardingError(pollError) || expired) {
          setSetup(null);
          setQrDataUrl("");
          setPhase("idle");
          setError("WhatsApp 二维码设置已过期。请重新开始二维码设置以重试。");
          return;
        }
        setError(`仍在等待 WhatsApp。重试中：${pollError}`);
        timeout = setTimeout(poll, 2000);
      }
    };

    timeout = setTimeout(poll, 1000);
    return () => {
      cancelled = true;
      if (timeout) clearTimeout(timeout);
    };
  }, [phase, setup, updateQr]);

  useEffect(() => {
    if (!setup) return;
    const timer = setInterval(() => setTick((value) => value + 1), 1000);
    return () => clearInterval(timer);
  }, [setup]);

  const resetSetup = () => {
    setSetup(null);
    setQrDataUrl("");
    setPhase("idle");
    setError("");
  };

  const start = async () => {
    setPhase("starting");
    setError("");
    setQrDataUrl("");
    try {
      const res = await api.startWhatsAppOnboarding({
        mode,
        allowed_users: allowedUsers,
      });
      setSetup(res);
      if (res.qr_payload) {
        await updateQr(res.qr_payload);
      }
      if (res.status === "error") {
        setError(res.error || "WhatsApp 设置失败。");
        setSetup(null);
        setPhase("idle");
      } else {
        setPhase(res.status === "connected" ? "connected" : "waiting");
      }
    } catch (startError) {
      setPhase("idle");
      setError(String(startError));
    }
  };

  const cancel = async () => {
    if (setup) {
      try {
        await api.cancelWhatsAppOnboarding(setup.pairing_id);
      } catch {
        /* local cleanup still wins */
      }
    }
    resetSetup();
  };

  const watchRestartOutcome = async () => {
    for (let i = 0; i < 20; i++) {
      await new Promise((resolve) => setTimeout(resolve, 1500));
      try {
        const st = await api.getActionStatus("gateway-restart", 5);
        if (st.running) continue;
        if (st.exit_code !== 0 && st.exit_code !== null) {
          onRestartNeeded();
          showToast(
            `网关重启失败（退出码 ${st.exit_code}）— 请手动重启`,
            "error",
          );
        }
        return;
      } catch {
        // transient fetch error; keep polling
      }
    }
  };

  const apply = async () => {
    if (!setup) return;
    setPhase("applying");
    setError("");
    try {
      const result = await api.applyWhatsAppOnboarding(setup.pairing_id, {
        mode,
        allowed_users: allowedUsers,
      });
      resetSetup();
      if (result.restart_started) {
        showToast("WhatsApp 已保存；网关正在重启…", "success");
        setRestartNeeded(false);
        setTimeout(() => void onChanged(), 4000);
        void watchRestartOutcome();
      } else {
        onRestartNeeded();
        const detail = result.restart_error ? `: ${result.restart_error}` : "";
        showToast(`WhatsApp 已保存；网关重启失败${detail}`, "error");
      }
      await onChanged();
    } catch (applyError) {
      setPhase("connected");
      setError(String(applyError));
    }
  };

  const expiresIn = useMemo(
    () => (setup ? formatExpiry(setup.expires_at) : ""),
    // tick keeps the memo fresh without recalculating on every render branch.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [setup, tick],
  );
  const setupStatusLabel =
    setup?.status === "installing"
      ? "准备中"
      : setup?.status === "starting"
        ? "启动中"
        : "等待中";
  const setupHelp =
    phase === "connected" || phase === "applying"
      ? "WhatsApp 已关联，但 Hermes 尚未开始监听。保存并重启网关以完成设置。"
      : setup?.status === "installing"
        ? "正在准备 WhatsApp 桥接。二维码准备好后会显示在这里。"
        : setup?.status === "starting"
          ? "正在启动 WhatsApp 配对桥接。二维码准备好后会显示在这里。"
          : "在手机上打开 WhatsApp，然后进入“已链接设备”并从那里扫描。此二维码不是浏览器网址。";
  const linkedAccountLabel = setup?.account_phone
    ? `+${setup.account_phone}`
    : setup?.account_name || setup?.account_id || "";
  const linkedAccountDetail =
    setup?.account_phone || setup?.account_id
      ? "这是 Hermes 当前登录的 WhatsApp 账号。"
      : "Hermes 已登录扫描此二维码的 WhatsApp 账号。";
  const linkedAccountChatUrl = setup?.account_phone
    ? `https://wa.me/${setup.account_phone}`
    : "";
  const messageInstruction =
    mode === "self-chat"
      ? "重启后，在关联账号上打开“给自己发消息”，向 Hermes 发送一条消息。"
      : "重启后，从另一个 WhatsApp 账号与关联账号开始聊天，并向 Hermes 发送一条消息。";
  const hasSavedAllowedUsers = Boolean(platform.whatsapp_setup?.allowed_users_set);
  const pairingInstruction =
    mode === "self-chat" && !allowedUsers.trim()
      ? hasSavedAllowedUsers
        ? "Hermes 将保留已保存的 WhatsApp 允许列表。"
        : "自聊模式下，保存时系统会自动允许关联账号。"
      : !allowedUsers.trim() && hasSavedAllowedUsers
        ? "Hermes 将保留已保存的 WhatsApp 允许列表。"
        : "如果未输入允许的号码，Hermes 会回复配对代码。请在仪表盘的配对页面批准。";

  return (
    <div className="rounded-sm border border-border bg-background/35 p-4">
      <div className="grid gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <Button
            size="sm"
            className="uppercase"
            onClick={() => void start()}
            disabled={phase === "starting" || phase === "waiting" || phase === "applying"}
            prefix={phase === "starting" ? <Spinner /> : <QrCode className="h-4 w-4" />}
          >
            {phase === "starting" ? "启动中…" : "扫码配对"}
          </Button>
          {platform.configured && (
            <span className="text-xs text-muted-foreground">
              已配置现有的 WhatsApp 设置。
            </span>
          )}
        </div>

        <div className="flex flex-col gap-3 lg:flex-row lg:items-end">
          <div className="grid gap-1.5">
            <span className="text-xs uppercase tracking-[0.12em] text-muted-foreground">
              模式
            </span>
            <div className="flex flex-wrap gap-2">
              <Button
                size="sm"
                outlined={mode !== "bot"}
                onClick={() => setMode("bot")}
                disabled={phase === "waiting" || phase === "applying"}
              >
                机器人
              </Button>
              <Button
                size="sm"
                outlined={mode !== "self-chat"}
                onClick={() => setMode("self-chat")}
                disabled={phase === "waiting" || phase === "applying"}
              >
                自聊
              </Button>
            </div>
          </div>
          <div className="grid min-w-0 flex-1 gap-1.5">
            <Label htmlFor="whatsapp-allowed-users">允许的 WhatsApp 号码</Label>
            <Input
              id="whatsapp-allowed-users"
              value={allowedUsers}
              onChange={(event) => setAllowedUsers(event.target.value)}
              disabled={phase === "waiting" || phase === "applying"}
              placeholder="15551234567,15557654321"
            />
          </div>
        </div>

        {error && (
          <div className="border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
            {error}
          </div>
        )}

        {setup && (
          <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_260px]">
            <div className="grid gap-3">
              <div className="flex flex-wrap items-center gap-2">
                {phase === "connected" || phase === "applying" ? (
                  <Badge tone="success">已连接</Badge>
                ) : (
                  <Badge tone="warning">{setupStatusLabel}</Badge>
                )}
                <Badge tone={expiresIn === "expired" ? "destructive" : "outline"}>
                  {expiresIn}
                </Badge>
              </div>

              <div className="text-sm text-muted-foreground">{setupHelp}</div>

              {phase === "waiting" && (
                <div className="text-xs text-muted-foreground">
                  保存后，未知私信将使用 Hermes 配对代码，除非其号码已被允许。
                </div>
              )}

              {(phase === "connected" || phase === "applying") && (
                <div className="grid gap-3">
                  <div className="border border-border bg-background/45 p-3 text-sm">
                    <div className="font-medium">
                      {linkedAccountLabel
                        ? `已关联为 ${linkedAccountLabel}`
                        : "WhatsApp 设备已关联"}
                    </div>
                    <div className="mt-1 text-muted-foreground">{linkedAccountDetail}</div>
                    <ol className="mt-3 list-decimal space-y-1 pl-5 text-muted-foreground">
                      <li>保存并重启网关。</li>
                      <li>{messageInstruction}</li>
                      <li>{pairingInstruction}</li>
                    </ol>
                    {linkedAccountChatUrl && (
                      <a
                        className="mt-3 inline-flex items-center gap-1 text-sm text-primary underline-offset-4 hover:underline"
                        href={linkedAccountChatUrl}
                        target="_blank"
                        rel="noreferrer"
                      >
                        打开聊天链接
                        <ExternalLink className="h-3.5 w-3.5" />
                      </a>
                    )}
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <Button
                      size="sm"
                      className="uppercase"
                      onClick={() => void apply()}
                      disabled={phase === "applying"}
                      prefix={phase === "applying" ? <Spinner /> : <Save className="h-4 w-4" />}
                    >
                      {phase === "applying" ? "保存中…" : "保存并重启"}
                    </Button>
                    <Button size="sm" ghost onClick={() => void cancel()}>
                      取消
                    </Button>
                  </div>
                </div>
              )}
            </div>

            <div className="flex flex-col items-center justify-center gap-3">
              {qrDataUrl ? (
                <img
                  src={qrDataUrl}
                  alt="WhatsApp 设置二维码"
                  className="h-60 w-60 bg-white p-2"
                />
              ) : phase === "connected" || phase === "applying" ? (
                <div className="flex h-60 w-60 flex-col items-center justify-center gap-2 border border-border bg-background/50 p-4 text-center">
                  <Badge tone="success">已关联</Badge>
                  <div className="text-sm text-muted-foreground">
                    {linkedAccountLabel || "找到现有 WhatsApp 会话"}
                  </div>
                </div>
              ) : (
                <div className="flex h-60 w-60 flex-col items-center justify-center gap-3 border border-border bg-background/50 p-4 text-center">
                  <Spinner className="text-2xl" />
                  <div className="text-xs text-muted-foreground">
                    正在等待 WhatsApp 提供二维码…
                  </div>
                </div>
              )}
              {phase === "waiting" && (
                <span className="text-center text-xs text-muted-foreground">
                  请使用 WhatsApp 的“已链接设备”扫描，而不是相机应用。
                </span>
              )}
              <Button size="sm" ghost onClick={() => void cancel()}>
                取消
              </Button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function TelegramOnboardingPanel({
  onManualSetup,
  onChanged,
  onRestartNeeded,
  platform,
  setRestartNeeded,
  showToast,
}: {
  onManualSetup: () => void;
  onChanged: () => Promise<void>;
  onRestartNeeded: () => void;
  platform: MessagingPlatform;
  setRestartNeeded: (needed: boolean) => void;
  showToast: (message: string, type: "success" | "error") => void;
}) {
  const [setup, setSetup] = useState<TelegramOnboardingStartResponse | null>(
    null,
  );
  const [qrDataUrl, setQrDataUrl] = useState("");
  const [phase, setPhase] = useState<
    "idle" | "starting" | "waiting" | "ready" | "applying"
  >("idle");
  const [botUsername, setBotUsername] = useState<string | null>(null);
  const [allowedIds, setAllowedIds] = useState<string[]>([]);
  const [detectedOwnerId, setDetectedOwnerId] = useState<string | null>(null);
  const [newAllowedId, setNewAllowedId] = useState("");
  const [error, setError] = useState("");
  const [tick, setTick] = useState(0);

  useEffect(() => {
    if (!setup || phase !== "waiting") return;
    let cancelled = false;
    let timeout: ReturnType<typeof setTimeout> | null = null;

    const poll = async () => {
      try {
        const status = await api.getTelegramOnboardingStatus(setup.pairing_id);
        if (cancelled) return;
        if (status.status === "ready") {
          setPhase("ready");
          setBotUsername(status.bot_username ?? null);
          setError("");
          if (
            status.owner_user_id &&
            TELEGRAM_USER_ID_RE.test(status.owner_user_id)
          ) {
            setDetectedOwnerId(status.owner_user_id);
            setAllowedIds([status.owner_user_id]);
          }
          return;
        }
        setError("");
        timeout = setTimeout(poll, 2000);
      } catch (pollError) {
        if (cancelled) return;

        const expiresAt = Date.parse(setup.expires_at);
        const expired =
          Number.isFinite(expiresAt) && Date.now() >= expiresAt;
        if (isTerminalTelegramOnboardingError(pollError) || expired) {
          setSetup(null);
          setQrDataUrl("");
          setPhase("idle");
          setError("Telegram 配对已过期。请重新开始二维码设置以重试。");
          return;
        }

        setError(`仍在等待 Telegram。重试中：${pollError}`);
        timeout = setTimeout(poll, 2000);
      }
    };

    timeout = setTimeout(poll, 1200);
    return () => {
      cancelled = true;
      if (timeout) clearTimeout(timeout);
    };
  }, [phase, setup]);

  useEffect(() => {
    if (!setup) return;
    const timer = setInterval(() => setTick((value) => value + 1), 1000);
    return () => clearInterval(timer);
  }, [setup]);

  const resetSetup = () => {
    setSetup(null);
    setQrDataUrl("");
    setPhase("idle");
    setBotUsername(null);
    setAllowedIds([]);
    setDetectedOwnerId(null);
    setNewAllowedId("");
    setError("");
  };

  const start = async () => {
    setPhase("starting");
    setError("");
    setBotUsername(null);
    setAllowedIds([]);
    setDetectedOwnerId(null);
    setNewAllowedId("");
    try {
      const res = await api.startTelegramOnboarding({ bot_name: "Hermes Agent" });
      const dataUrl = await QRCode.toDataURL(res.qr_payload, {
        errorCorrectionLevel: "M",
        margin: 1,
        width: 224,
      });
      setSetup(res);
      setQrDataUrl(dataUrl);
      setPhase("waiting");
    } catch (startError) {
      setPhase("idle");
      setError(String(startError));
    }
  };

  const cancel = async () => {
    if (setup) {
      try {
        await api.cancelTelegramOnboarding(setup.pairing_id);
      } catch {
        /* local cleanup still wins */
      }
    }
    resetSetup();
  };

  const addAllowedId = () => {
    const trimmed = newAllowedId.trim();
    if (!TELEGRAM_USER_ID_RE.test(trimmed)) {
      setError("允许的 Telegram 用户 ID 必须是数字。");
      return;
    }
    setError("");
    setAllowedIds((ids) => (ids.includes(trimmed) ? ids : [...ids, trimmed]));
    setNewAllowedId("");
  };

  // restart_started only means the `hermes gateway restart` child spawned —
  // not that the restart will succeed (e.g. systemd linger missing, service
  // manager failure). Poll the action status briefly and surface a non-zero
  // exit via the manual-restart banner. Note: in no-service installs the
  // child becomes the foreground gateway and never exits, so "still running
  // when the window closes" counts as success.
  const watchRestartOutcome = async () => {
    for (let i = 0; i < 20; i++) {
      await new Promise((resolve) => setTimeout(resolve, 1500));
      try {
        const st = await api.getActionStatus("gateway-restart", 5);
        if (st.running) continue;
        if (st.exit_code !== 0 && st.exit_code !== null) {
          onRestartNeeded();
          showToast(
            `网关重启失败（退出码 ${st.exit_code}）— 请手动重启`,
            "error",
          );
        }
        return;
      } catch {
        // transient fetch error; keep polling
      }
    }
  };

  const apply = async () => {
    if (!setup) return;
    if (allowedIds.length === 0) {
      setError("请至少添加一个允许的 Telegram 用户 ID。");
      return;
    }
    setPhase("applying");
    setError("");
    try {
      const result = await api.applyTelegramOnboarding(setup.pairing_id, {
        allowed_user_ids: allowedIds,
      });
      resetSetup();
      if (result.restart_started) {
        showToast("Telegram 已保存；网关正在重启…", "success");
        setRestartNeeded(false);
        setTimeout(() => void onChanged(), 4000);
        void watchRestartOutcome();
      } else if (result.restart_started === undefined && result.needs_restart) {
        try {
          await api.restartGateway();
          showToast("Telegram 已保存；网关正在重启…", "success");
          setRestartNeeded(false);
          setTimeout(() => void onChanged(), 4000);
        } catch (restartError) {
          onRestartNeeded();
          showToast(`Telegram 已保存；网关重启失败：${restartError}`, "error");
        }
      } else {
        onRestartNeeded();
        const detail = result.restart_error ? `: ${result.restart_error}` : "";
        showToast(`Telegram 已保存；网关重启失败${detail}`, "error");
      }
      await onChanged();
    } catch (applyError) {
      setPhase("ready");
      setError(String(applyError));
    }
  };

  const expiresIn = useMemo(
    () => (setup ? formatExpiry(setup.expires_at) : ""),
    // tick keeps the memo fresh without recalculating on every render branch.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [setup, tick],
  );

  return (
    <div className="rounded-sm border border-border bg-background/35 p-4">
      <div className="grid gap-1">
        <span className="font-mondwest text-sm text-foreground">
          选择如何连接你的 Telegram 机器人
        </span>
        <span className="text-xs text-muted-foreground">
          两种方式都会连接一个由你控制的机器人，并仅将其凭据保存到此 Hermes 安装中。
        </span>
      </div>

      <div className="mt-4 grid gap-4 sm:grid-cols-2 sm:divide-x sm:divide-border">
        <div className="grid content-start gap-3 sm:pr-4">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs font-medium uppercase text-foreground">
              快速设置
            </span>
            <Badge tone="success">推荐</Badge>
          </div>
          <p className="text-xs text-muted-foreground">
            扫描二维码并在 Telegram 中确认。Hermes 会自动创建机器人并检测你的 Telegram 用户 ID。
          </p>
          <Button
            size="sm"
            className="w-fit uppercase"
            onClick={() => void start()}
            disabled={phase !== "idle"}
            prefix={phase === "starting" ? <Spinner /> : <QrCode className="h-4 w-4" />}
          >
            {phase === "starting" ? "启动中…" : "扫码创建"}
          </Button>
        </div>

        <div className="grid content-start gap-3 border-t border-border pt-4 sm:border-t-0 sm:pl-4 sm:pt-0">
          <span className="text-xs font-medium uppercase text-foreground">
            使用你自己的机器人
          </span>
          <p className="text-xs text-muted-foreground">
            使用 @BotFather 创建机器人，或连接一个你已有的机器人，方法是输入其令牌并选择可以使用它的人。
          </p>
          <Button
            size="sm"
            outlined
            className="w-fit uppercase"
            onClick={onManualSetup}
            disabled={phase !== "idle"}
            prefix={<Bot className="h-4 w-4" />}
          >
            手动设置
          </Button>
        </div>
      </div>

      {platform.configured && (
        <div className="mt-4 border-t border-border pt-3 text-xs text-muted-foreground">
          Telegram 凭据已配置。新的二维码设置或机器人令牌将在你保存时替换当前机器人。
        </div>
      )}

      {phase !== "idle" && (
        <div className="mt-4 border-t border-border pt-4">
          <span className="text-xs text-muted-foreground">
            在切换方式前，请先完成或取消当前的二维码设置。
          </span>
        </div>
      )}

      {error && (
        <div className="mt-3 border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </div>
      )}

      {setup && qrDataUrl && (
        <div className="mt-4 grid gap-4 lg:grid-cols-[minmax(0,1fr)_260px]">
          <div className="grid gap-3">
            {(phase === "ready" || phase === "applying") && (
              <div className="grid gap-3">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge tone="success">就绪</Badge>
                  {botUsername && (
                    <span className="font-courier text-sm text-muted-foreground">
                      @{botUsername}
                    </span>
                  )}
                </div>

                <div className="grid gap-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-xs uppercase tracking-[0.12em] text-muted-foreground">
                      允许的用户
                    </span>
                    {detectedOwnerId && allowedIds.includes(detectedOwnerId) && (
                      <Badge tone="success">已检测到所有者</Badge>
                    )}
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {allowedIds.map((id) => (
                      <button
                        key={id}
                        type="button"
                        className="inline-flex items-center gap-1 border border-border px-2 py-1 font-courier text-xs text-foreground hover:border-destructive/50"
                        onClick={() =>
                          setAllowedIds((ids) =>
                            ids.filter((existing) => existing !== id),
                          )
                        }
                      >
                        {id}
                        <X className="h-3 w-3" />
                      </button>
                    ))}
                    {allowedIds.length === 0 && (
                      <span className="text-sm text-muted-foreground">
                        请至少添加一个 Telegram 用户 ID。
                      </span>
                    )}
                  </div>
                </div>

                <div className="flex flex-col gap-2 sm:flex-row">
                  <Input
                    value={newAllowedId}
                    onChange={(event) => setNewAllowedId(event.target.value)}
                    placeholder="Telegram 用户 ID"
                    className="font-courier"
                  />
                  <Button size="sm" outlined onClick={addAllowedId} prefix={<Check />}>
                    添加
                  </Button>
                </div>

                <div className="flex flex-wrap gap-2">
                  <Button
                    size="sm"
                    className="uppercase"
                    onClick={() => void apply()}
                    disabled={phase === "applying"}
                    prefix={phase === "applying" ? <Spinner /> : <Save className="h-4 w-4" />}
                  >
                    {phase === "applying" ? "保存中…" : "保存并重启"}
                  </Button>
                  <Button size="sm" ghost onClick={() => void cancel()}>
                    取消
                  </Button>
                </div>
              </div>
            )}
          </div>

          <div className="flex flex-col items-center justify-center gap-3">
            <img
              src={qrDataUrl}
              alt="Telegram 设置二维码"
              className="h-56 w-56 bg-white p-2"
            />
            <div className="flex flex-wrap items-center justify-center gap-2 text-sm">
              <Badge tone={expiresIn === "expired" ? "destructive" : "outline"}>
                {expiresIn}
              </Badge>
              {phase === "waiting" && <Badge tone="warning">等待中</Badge>}
            </div>
            <div className="flex flex-wrap justify-center gap-2">
              <a
                href={setup.deep_link}
                target="_blank"
                rel="noreferrer"
                className="inline-flex h-8 items-center gap-1 border border-border px-3 text-xs uppercase text-foreground hover:border-foreground/40"
              >
                <ExternalLink className="h-4 w-4" />
                打开 Telegram
              </a>
              <Button size="sm" ghost onClick={() => void cancel()}>
                取消
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
