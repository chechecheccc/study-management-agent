"use client";

import { useState } from "react";
import type { PublicAccount } from "../lib/accounts";

type Props = {
  accounts: PublicAccount[];
  onLogin: (username: string, password: string) => Promise<string | null>;
};

// 登录界面：展示预置账号提示，方便演示与首次使用。
export function LoginScreen({ accounts, onLogin }: Props) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError("");
    const message = await onLogin(username, password);
    if (message) setError(message);
    setBusy(false);
  };

  const quickFill = (name: string, pass: string) => {
    setUsername(name);
    setPassword(pass);
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
        <h1>登录你的学习空间</h1>
        <p className="auth-copy">每个账号拥有独立的资料库、任务、复习计划与对话记录。</p>

        <form onSubmit={submit} className="auth-form">
          <label>
            <span>用户名</span>
            <input
              value={username}
              onChange={(event) => setUsername(event.target.value)}
              placeholder="例如 admin"
              autoComplete="username"
              aria-label="用户名"
            />
          </label>
          <label>
            <span>密码</span>
            <input
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              placeholder="请输入密码"
              autoComplete="current-password"
              aria-label="密码"
            />
          </label>
          {error ? <div className="auth-error">{error}</div> : null}
          <button className="primary-button wide" type="submit" disabled={busy}>
            {busy ? "正在登录…" : "登录"}
          </button>
        </form>

        <div className="auth-accounts">
          <div className="section-label">预置账号（点击填入）</div>
          {accounts.map((account) => (
            <button
              className="auth-account-row"
              key={account.id}
              type="button"
              onClick={() => quickFill(account.username, account.username === "admin" ? "admin123" : "123456")}
            >
              <span className={`role-badge ${account.role}`}>{account.role === "admin" ? "管理员" : "学生"}</span>
              <strong>{account.displayName}</strong>
              <small>{account.username}</small>
            </button>
          ))}
          <small className="auth-hint">演示密码：管理员 admin123，普通用户 123456。登录后管理员可以在「账号管理」里新增或停用账号。</small>
        </div>
      </section>
    </main>
  );
}


