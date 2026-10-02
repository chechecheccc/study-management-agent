"use client";

import { useState } from "react";
import type { PublicAccount } from "../lib/accounts";

type Props = {
  accounts: PublicAccount[];
  currentUserId: string;
  onCreate: (input: { username: string; displayName: string; password: string; role: "admin" | "user" }) => Promise<string | null>;
  onToggleDisabled: (userId: string) => void;
  onResetPassword: (userId: string, password: string) => Promise<string | null>;
  onDelete: (userId: string) => void;
};

// 管理员面板：新增账号、停用/启用、重置密码、删除。
export function AccountPanel({ accounts, currentUserId, onCreate, onToggleDisabled, onResetPassword, onDelete }: Props) {
  const [username, setUsername] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [password, setPassword] = useState("");
  const [role, setRole] = useState<"admin" | "user">("user");
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);
  const [resetTarget, setResetTarget] = useState<string | null>(null);
  const [resetValue, setResetValue] = useState("");

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setMessage("");
    setError("");
    const failure = await onCreate({ username, displayName, password, role });
    if (failure) {
      setError(failure);
      return;
    }
    setMessage(`已创建账号 ${username}。`);
    setUsername("");
    setDisplayName("");
    setPassword("");
    setRole("user");
  };

  const confirmReset = async () => {
    if (!resetTarget) return;
    setError("");
    const failure = await onResetPassword(resetTarget, resetValue);
    if (failure) {
      setError(failure);
      return;
    }
    setMessage("密码已重置。");
    setResetTarget(null);
    setResetValue("");
  };

  return (
    <div className="page-view">
      <div className="page-header">
        <div>
          <div className="eyebrow">ADMIN</div>
          <h1>账号管理</h1>
          <p>每个账号拥有独立的资料库、任务、复习计划与对话记录。</p>
        </div>
        <div className="page-header-action"><span className="local-badge">管理员</span></div>
      </div>

      <div className="account-grid">
        <div className="data-card">
          <div className="card-kicker">NEW ACCOUNT</div>
          <h3>新增账号</h3>
          <form className="form-grid profile-form" onSubmit={submit}>
            <input value={username} onChange={(event) => setUsername(event.target.value)} placeholder="用户名（3-20 位小写字母/数字）" aria-label="新账号用户名" />
            <input value={displayName} onChange={(event) => setDisplayName(event.target.value)} placeholder="显示名称，例如 小林" aria-label="新账号显示名称" />
            <input type="password" value={password} onChange={(event) => setPassword(event.target.value)} placeholder="密码（至少 6 位）" aria-label="新账号密码" />
            <select value={role} onChange={(event) => setRole(event.target.value as "admin" | "user")} aria-label="新账号角色">
              <option value="user">普通用户</option>
              <option value="admin">管理员</option>
            </select>
            <button className="primary-button" type="submit">创建账号</button>
          </form>
          {error ? <div className="queue-error">{error}</div> : null}
          {message ? <div className="account-success">{message}</div> : null}
        </div>

        <div className="data-card">
          <div className="card-kicker">ACCOUNTS · {accounts.length}</div>
          <h3>账号列表</h3>
          <div className="account-list">
            {accounts.map((account) => (
              <div className={`account-row ${account.disabled ? "disabled" : ""}`} key={account.id}>
                <span className={`role-badge ${account.role}`}>{account.role === "admin" ? "管理员" : "学生"}</span>
                <div className="account-main">
                  <strong>{account.displayName}</strong>
                  <small>{account.username}{account.id === currentUserId ? " · 当前登录" : ""}{account.disabled ? " · 已停用" : ""}</small>
                </div>
                <div className="account-actions">
                  {resetTarget === account.id ? (
                    <>
                      <input value={resetValue} onChange={(event) => setResetValue(event.target.value)} placeholder="新密码" aria-label="重置密码" />
                      <button className="quiet-button" onClick={confirmReset}>确定</button>
                      <button className="text-button" onClick={() => { setResetTarget(null); setResetValue(""); }}>取消</button>
                    </>
                  ) : (
                    <>
                      <button className="quiet-button" onClick={() => { setResetTarget(account.id); setResetValue(""); }}>重置密码</button>
                      <button className="quiet-button" onClick={() => onToggleDisabled(account.id)} disabled={account.id === currentUserId}>
                        {account.disabled ? "启用" : "停用"}
                      </button>
                      {pendingDelete === account.id ? (
                        <>
                          <button className="quiet-button danger" onClick={() => { onDelete(account.id); setPendingDelete(null); }}>确认删除</button>
                          <button className="text-button" onClick={() => setPendingDelete(null)}>取消</button>
                        </>
                      ) : (
                        <button className="text-button" onClick={() => setPendingDelete(account.id)} disabled={account.id === currentUserId}>删除</button>
                      )}
                    </>
                  )}
                </div>
              </div>
            ))}
          </div>
          <small className="auth-hint">停用后该账号无法登录，但数据仍保留在本机；删除账号会同时清除它的本地数据。</small>
        </div>
      </div>
    </div>
  );
}

