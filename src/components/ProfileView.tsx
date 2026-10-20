import { useCallback, useEffect, useState } from "react";
import { LoaderCircle, ShieldCheck } from "lucide-react";
import "../profile.css";
import { StatusBadge, ViewHeading, type ViewProps } from "./shared";
import { formatDateTime } from "./crm/crm-shared";
import {
  deleteProfileSession,
  fetchProfileView,
  profileErrorMessage,
  putProfilePrefs,
  putProfileSession,
  testProfileSession,
  type ProfilePublicView,
  type ProfileTestResult,
} from "../lib/profile-client";

/**
 * 个人中心（Cookie/BUC 会话与判活）：账号卡 / 会话来源三态 / manual 粘贴表单 /
 * BUC 判活三态 / prefs 开关组。红线口径：
 * - 界面永远只见掩码与元数据（source/domains/updatedAt/lastCheck/verifiedAt/empId/name），
 *   Cookie 原值只在提交瞬间经 PUT 请求体发给本机桥，提交后立即清空输入；
 * - chrome/auto 提取未接入时如实展示 supported:false 的原因，绝不假绿；
 * - 未配置时给诚实引导态（徽章口径参照设置页「只读 · 不写配置」风格）。
 */

const SOURCE_LABELS: Readonly<Record<string, string>> = {
  manual: "手工粘贴",
  chrome: "Chrome 提取（未接入）",
  auto: "自动 · 手工+Chrome（未接入）",
};

const SESSION_STATE: Readonly<Record<string, { label: string; tone: "green" | "amber" | "blue" | "muted" }>> = {
  ok: { label: "判活通过", tone: "green" },
  set: { label: "已保存 · 未判活", tone: "blue" },
  bad: { label: "判活失败", tone: "amber" },
  unset: { label: "未配置", tone: "muted" },
};

interface PrefDef {
  readonly key: string;
  readonly label: string;
  readonly hint: string;
}

const PREF_DEFS: readonly PrefDef[] = [
  { key: "autoCheckOnOpen", label: "打开本页时自动判活", hint: "仅在你手动进入本页时触发一次，无后台轮询" },
  { key: "maskEmpId", label: "账号信息界面遮挡", hint: "工号 / 姓名以 CSS 模糊遮挡（演示或投屏时用）" },
];

interface Badge {
  readonly tone: "green" | "amber" | "muted";
  readonly label: string;
}

function lastCheckBadge(view: ProfilePublicView): { tone: "green" | "amber" | "muted"; label: string } | null {
  const check = view.session.lastCheck;
  if (!check) return null;
  if (check.ok && check.self === true) return { tone: "green", label: `判活通过 · 本人（${formatDateTime(check.at)}）` };
  if (check.ok && check.self === false) return { tone: "amber", label: `会话非本人${check.empId ? `（属于 ${check.empId}）` : ""}` };
  return { tone: "amber", label: `判活失败${check.code ? `（${check.code}）` : ""} · ${formatDateTime(check.at)}` };
}

function TestOutcomeRow({ result }: { result: ProfileTestResult }) {
  if (result.state === "self") {
    return (
      <p className="profile-test__row" data-state="self">
        <StatusBadge tone="green">本人</StatusBadge>
        <span>BUC 会话有效，且与当前账号一致{result.name ? `（${result.name}）` : ""} · {formatDateTime(result.checkedAt)}</span>
      </p>
    );
  }
  if (result.state === "mismatch") {
    return (
      <p className="profile-test__row" data-state="mismatch">
        <StatusBadge tone="amber">非本人</StatusBadge>
        <span>{result.note}</span>
      </p>
    );
  }
  return (
    <p className="profile-test__row" data-state="failed">
      <StatusBadge tone="muted">失败</StatusBadge>
      <span>{result.note}{result.code ? `（${result.code}）` : ""}</span>
    </p>
  );
}

export function ProfileView(_props: ViewProps) {
  const [view, setView] = useState<ProfilePublicView | null>(null);
  const [loadError, setLoadError] = useState("");
  const [empIdInput, setEmpIdInput] = useState("");
  const [cookieInput, setCookieInput] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveBadge, setSaveBadge] = useState<Badge | null>(null);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<ProfileTestResult | null>(null);
  const [actionError, setActionError] = useState("");
  const [prefsBusy, setPrefsBusy] = useState(false);

  useEffect(() => {
    let mounted = true;
    fetchProfileView()
      .then((loaded) => {
        if (!mounted) return;
        setView(loaded);
        setLoadError("");
        if (loaded.user.empId) setEmpIdInput((current) => current || loaded.user.empId);
      })
      .catch((error: unknown) => {
        if (mounted) setLoadError(profileErrorMessage(error));
      });
    return () => { mounted = false; };
  }, []);

  const submitSession = useCallback(async (event: React.FormEvent) => {
    event.preventDefault();
    if (saving) return;
    setSaving(true);
    setSaveBadge(null);
    setActionError("");
    const value = cookieInput;
    try {
      const result = await putProfileSession({
        source: "manual",
        value,
        empId: empIdInput.trim() || undefined,
      });
      if (result.supported && result.view) {
        setView(result.view);
        setSaveBadge({ tone: "green", label: "已保存 · 本机 0600 落盘，永不回显" });
      } else {
        setSaveBadge({ tone: "amber", label: result.reason ?? "该来源本期未接入" });
      }
    } catch (error: unknown) {
      setSaveBadge({ tone: "amber", label: "保存失败" });
      setActionError(profileErrorMessage(error));
    } finally {
      // 提交后立即清空敏感输入（成功失败都清，原值只存在于本机 0600 文件）。
      setCookieInput("");
      setSaving(false);
    }
  }, [cookieInput, empIdInput, saving]);

  const clearSession = useCallback(async () => {
    setActionError("");
    try {
      setView(await deleteProfileSession());
      setSaveBadge({ tone: "muted", label: "已清除本机会话" });
      setTestResult(null);
    } catch (error: unknown) {
      setActionError(profileErrorMessage(error));
    }
  }, []);

  const runTest = useCallback(async () => {
    if (testing) return;
    setTesting(true);
    setActionError("");
    try {
      const result = await testProfileSession();
      setTestResult(result);
      setView(result.view);
    } catch (error: unknown) {
      setActionError(profileErrorMessage(error));
    } finally {
      setTesting(false);
    }
  }, [testing]);

  const togglePref = useCallback(async (key: string, next: boolean) => {
    if (prefsBusy) return;
    setPrefsBusy(true);
    setActionError("");
    try {
      const result = await putProfilePrefs({ [key]: next });
      setView(result.view);
    } catch (error: unknown) {
      setActionError(profileErrorMessage(error));
    } finally {
      setPrefsBusy(false);
    }
  }, [prefsBusy]);

  if (loadError && !view) {
    return (
      <div className="view-stack">
        <ViewHeading
          eyebrow="PROFILE & SESSION / 09"
          title="个人中心"
          description="Cookie/BUC 会话与判活。"
          aside={<StatusBadge tone="muted">本机存储 · Cookie 不回显</StatusBadge>}
        />
        <section className="panel profile-panel" aria-label="个人中心不可用">
          <div className="profile-panel__body">
            <p className="profile-note profile-note--warn">{loadError}</p>
          </div>
        </section>
      </div>
    );
  }

  const session = view?.session ?? null;
  const stateBadge = SESSION_STATE[session?.state ?? "unset"] ?? SESSION_STATE.unset!;
  const checkBadge = view ? lastCheckBadge(view) : null;
  const masked = view?.prefs.maskEmpId === true;

  return (
    <div className="view-stack">
      <ViewHeading
        eyebrow="PROFILE & SESSION / 09"
        title="个人中心"
        description="内网平台共用一份 BUC 会话 Cookie（aliyun-inc.com / alibaba-inc.com 白名单后缀）。原值只落本机 ~/.sa-workbench（0600），界面与日志只出现掩码与元数据。"
        aside={<StatusBadge tone="blue">本机存储 · 0600 · Cookie 不回显</StatusBadge>}
      />

      {view && !view.configured && (
        <section className="panel profile-panel" aria-label="未配置引导">
          <div className="profile-panel__body">
            <p className="profile-note">
              <ShieldCheck size={13} /> 尚未配置账号：在下方填写工号并粘贴一次 BUC 共享会话 Cookie 即可完成配置。
              Chrome / 自动提取本期未接入（会如实返回「chrome 提取未接入」，不会伪造成功）；判活走 BUC 身份接口，只回传工号与显示名。
            </p>
          </div>
        </section>
      )}

      <section className="panel profile-panel" aria-label="账号卡">
        <div className="panel__header">
          <div><span className="eyebrow">ACCOUNT / 09</span><h2>账号卡</h2></div>
          <span className="profile-panel__hint">empId / name / 判活时间 · 只展示掩码元数据</span>
        </div>
        <div className="profile-panel__body">
          <div className="profile-account">
            <div className="profile-account__id">
              <strong className={masked ? "profile-mask" : ""}>{view?.user.empId || "（未配置）"}</strong>
              <span className={masked ? "profile-mask" : ""}>{view?.user.name || "—"}</span>
            </div>
            <dl className="profile-account__meta">
              <div><dt>最近判活通过（verifiedAt）</dt><dd>{formatDateTime(session?.verifiedAt ?? null)}</dd></div>
              <div><dt>最近检查（lastCheck）</dt><dd>{formatDateTime(session?.lastCheck?.at ?? null)}</dd></div>
              <div><dt>会话来源</dt><dd>{SOURCE_LABELS[view?.source.mode ?? "manual"] ?? view?.source.mode}</dd></div>
              <div><dt>会话更新（updatedAt）</dt><dd>{formatDateTime(session?.updatedAt ?? null)}</dd></div>
              <div><dt>生效域名后缀</dt><dd>{(session?.domains ?? []).join(" / ") || "—"}</dd></div>
              <div><dt>会话状态</dt><dd><StatusBadge tone={stateBadge.tone}>{stateBadge.label}</StatusBadge>{session?.set ? <span className="profile-account__mask">{session.masked} · {session.count} 项</span> : null}</dd></div>
            </dl>
            {checkBadge && <p className="profile-note"><StatusBadge tone={checkBadge.tone}>{checkBadge.label}</StatusBadge></p>}
          </div>
        </div>
      </section>

      <section className="panel profile-panel" aria-label="会话配置">
        <div className="panel__header">
          <div><span className="eyebrow">SESSION / 09</span><h2>会话配置（manual 粘贴）</h2></div>
          <span className="profile-panel__hint">type=password · 提交后清空 · 原值不回显</span>
        </div>
        <div className="profile-panel__body">
          <form className="profile-form" onSubmit={submitSession}>
            <label className="profile-form__field">
              <span>工号（empId）</span>
              <input
                type="text"
                value={empIdInput}
                onChange={(event) => setEmpIdInput(event.target.value)}
                placeholder="如 SYN-EMP-0001（1-32 位字母/数字/_/-）"
                autoComplete="off"
                maxLength={32}
              />
            </label>
            <label className="profile-form__field">
              <span>BUC 共享会话 Cookie</span>
              <input
                type="password"
                value={cookieInput}
                onChange={(event) => setCookieInput(event.target.value)}
                placeholder="粘贴 Cookie 头（仅 aliyun-inc.com / alibaba-inc.com 白名单后缀生效）"
                autoComplete="off"
              />
            </label>
            <div className="profile-form__actions">
              <button type="submit" className="profile-button" disabled={saving || !cookieInput.trim()}>
                {saving ? <LoaderCircle className="spin" size={13} /> : <ShieldCheck size={13} />}
                {saving ? "保存中…" : "保存会话"}
              </button>
              <button type="button" className="text-button" onClick={clearSession} disabled={!session?.set}>
                清除本机会话
              </button>
              {saveBadge && <StatusBadge tone={saveBadge.tone}>{saveBadge.label}</StatusBadge>}
            </div>
          </form>
          <div className="profile-form__test">
            <button type="button" className="profile-button" onClick={runTest} disabled={testing || !session?.set}>
              {testing ? <LoaderCircle className="spin" size={13} /> : <ShieldCheck size={13} />}
              {testing ? "判活中…（≤20s）" : "判活（BUC）"}
            </button>
            {testResult && <TestOutcomeRow result={testResult} />}
            {!session?.set && <small className="profile-note profile-note--dim">保存会话后可判活；chrome / auto 来源本期未接入。</small>}
          </div>
          {actionError && <p className="profile-note profile-note--warn">{actionError}</p>}
        </div>
      </section>

      <section className="panel profile-panel" aria-label="偏好开关">
        <div className="panel__header">
          <div><span className="eyebrow">PREFS / 09</span><h2>偏好开关</h2></div>
          <span className="profile-panel__hint">合并写入 profile.prefs · 不可变更新</span>
        </div>
        <div className="profile-panel__body">
          {PREF_DEFS.map((pref) => {
            const enabled = view?.prefs[pref.key] === true;
            return (
              <div className="profile-pref" key={pref.key}>
                <button
                  type="button"
                  className={`profile-toggle ${enabled ? "is-on" : ""}`}
                  role="switch"
                  aria-checked={enabled}
                  aria-label={pref.label}
                  disabled={prefsBusy || !view?.configured}
                  onClick={() => togglePref(pref.key, !enabled)}
                >
                  <span className="profile-toggle__knob" aria-hidden="true" />
                  <span className="profile-toggle__label">{enabled ? "已开启" : "已关闭"}</span>
                </button>
                <div className="profile-pref__copy">
                  <strong>{pref.label}</strong>
                  <small>{pref.hint}</small>
                </div>
              </div>
            );
          })}
          {!view?.configured && <small className="profile-note profile-note--dim">完成会话配置后可保存偏好。</small>}
        </div>
      </section>
    </div>
  );
}
