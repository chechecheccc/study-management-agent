"use client";

import { useState } from "react";

type Props = {
  onLogin: (username: string, password: string) => Promise<string | null>;
  onRegister: (username: string, displayName: string, password: string) => Promise<string | null>;
};

// 登录 / 注册：账号保存在服务端数据库，支持换设备登录后同步数据
export function LoginScreen({ onLogin, onRegister }: Props) {
  const [mode, setMode] = useState<"login" | "register">("login");
  const [username, setUsername] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError("");
    const message = mode === "login"
      ? await onLogin(username, password)
      : await onRegister(username, displayName, password);
    if (message) setError(message);
    setBusy(false);
  };

  const switchMode = (next: "login" | "register") => {
    setMode(next);
    setError("");
  };

  return (
    <main className="auth-shell">
      <div className="ambient-glow ambient-glow-one" aria-hidden="true" />
      <div className="ambient-glow ambient-glow-two" aria-hidden="true" />
      <section className="auth-card" aria-label="登录浅浅">
        <div className="auth-brand">
          <div className="brand-mark">浅</div>
          <div>
            <div className="brand-name">浅浅</div>
            <div className="brand-caption">qianqian</div>
          </div>
        </div>

        <div className="auth-tabs" role="tablist">
          <button
            type="button"
            role="tab"
            aria-selected={mode === "login"}
            className={`auth-tab ${mode === "login" ? "active" : ""}`}
            onClick={() => switchMode("login")}
          >
            登录
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={mode === "register"}
            className={`auth-tab ${mode === "register" ? "active" : ""}`}
            onClick={() => switchMode("register")}
          >
            注册
          </button>
        </div>

        <p className="auth-copy">
          {mode === "login"
            ? "在任意设备登录同一账号，课程、任务、对话与记忆会自动同步。"
            : "注册后即可在其它设备登录，数据自动同步。"}
        </p>

        <form onSubmit={submit} className="auth-form">
          <label>
            <span>用户名</span>
            <input
              value={username}
              onChange={(event) => setUsername(event.target.value)}
              placeholder="3-20 位小写字母或数字"
              autoComplete="username"
              aria-label="用户名"
            />
          </label>
          {mode === "register" ? (
            <label>
              <span>显示名称</span>
              <input
                value={displayName}
                onChange={(event) => setDisplayName(event.target.value)}
                placeholder="例如 小林"
                aria-label="显示名称"
              />
            </label>
          ) : null}
          <label>
            <span>密码</span>
            <input
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              placeholder={mode === "register" ? "至少 6 位" : "请输入密码"}
              autoComplete={mode === "register" ? "new-password" : "current-password"}
              aria-label="密码"
            />
          </label>
          {error ? <div className="auth-error">{error}</div> : null}
          <button className="primary-button wide" type="submit" disabled={busy}>
            {busy ? "正在处理…" : mode === "login" ? "登录" : "注册并进入"}
          </button>
        </form>

        <div className="auth-accounts">
          <div className="section-label">预置演示账号（点击填入）</div>
          <button className="auth-account-row" type="button" onClick={() => { setMode("login"); setUsername("admin"); setPassword("admin123"); setError(""); }}>
            <span className="role-badge admin">管理员</span>
            <strong>管理员</strong>
            <small>admin</small>
          </button>
          <button className="auth-account-row" type="button" onClick={() => { setMode("login"); setUsername("student1"); setPassword("123456"); setError(""); }}>
            <span className="role-badge user">学生</span>
            <strong>小林</strong>
            <small>student1</small>
          </button>
          <button className="auth-account-row" type="button" onClick={() => { setMode("login"); setUsername("student2"); setPassword("123456"); setError(""); }}>
            <span className="role-badge user">学生</span>
            <strong>小周</strong>
            <small>student2</small>
          </button>
          <small className="auth-hint">演示密码：管理员 admin123，普通用户 123456。管理员可在「账号管理」里新增或停用账号。</small>
        </div>
      </section>
    </main>
  );
}
