"use client";

import type { Course, Resource, Task } from "../lib/local-store";
import type { ImportQueueItem, PendingResourceDraft } from "../lib/import-queue";

const statusLabels: Record<ImportQueueItem["status"], string> = {
  queued: "排队中",
  processing: "识别中",
  awaiting_confirmation: "待确认",
  saving: "保存中",
  saved: "已入库",
  failed: "失败",
  cancelled: "已取消",
};

type Props = {
  items: ImportQueueItem[];
  courses: Course[];
  running: boolean;
  onResourceChange: (id: string, patch: Partial<PendingResourceDraft>) => void;
  onTaskChange: (id: string, patch: Partial<Task>) => void;
  onToggleTask: (id: string, include: boolean) => void;
  onConfirm: (id: string) => void | Promise<void>;
  onCancel: (id: string) => void;
  onRetry: (id: string) => void | Promise<void>;
  onManual: (id: string) => void;
  onRemove: (id: string) => void;
  onClearFinished: () => void;
};

export function BatchImportQueue({
  items,
  courses,
  running,
  onResourceChange,
  onTaskChange,
  onToggleTask,
  onConfirm,
  onCancel,
  onRetry,
  onManual,
  onRemove,
  onClearFinished,
}: Props) {
  if (!items.length) return null;

  const savedCount = items.filter((item) => item.status === "saved").length;
  const confirmationCount = items.filter((item) => item.status === "awaiting_confirmation").length;
  const settledCount = items.filter((item) => !["queued", "processing", "saving"].includes(item.status)).length;
  const progress = Math.round((settledCount / items.length) * 100);

  return (
    <section className="import-queue" aria-label="批量导入队列">
      <div className="import-queue-head">
        <div>
          <span className="action-label">批量导入队列</span>
          <strong>{items.length} 个文件 · {savedCount} 个已入库 · {confirmationCount} 个待确认</strong>
        </div>
        <button className="text-button" onClick={onClearFinished} disabled={!items.some((item) => item.status === "saved" || item.status === "cancelled")}>清理已结束</button>
      </div>
      <div className="queue-progress" aria-label={`批次处理进度 ${progress}%`}><span style={{ width: `${progress}%` }} /></div>
      <div className="queue-list">
        {items.map((item) => (
          <ImportQueueRow
            key={item.id}
            item={item}
            courses={courses}
            running={running}
            onResourceChange={onResourceChange}
            onTaskChange={onTaskChange}
            onToggleTask={onToggleTask}
            onConfirm={onConfirm}
            onCancel={onCancel}
            onRetry={onRetry}
            onManual={onManual}
            onRemove={onRemove}
          />
        ))}
      </div>
    </section>
  );
}

function ImportQueueRow({
  item,
  courses,
  running,
  onResourceChange,
  onTaskChange,
  onToggleTask,
  onConfirm,
  onCancel,
  onRetry,
  onManual,
  onRemove,
}: Omit<Props, "items" | "onClearFinished"> & { item: ImportQueueItem }) {
  const draft = item.resourceDraft;
  const task = item.taskDraft;
  const busy = item.status === "processing" || item.status === "saving";

  return (
    <article className={`queue-item status-${item.status}`}>
      <div className="queue-item-summary">
        <span className="queue-file-mark">{fileMark(item.file.name)}</span>
        <div>
          <strong title={item.file.name}>{item.file.name}</strong>
          <small>{formatBytes(item.file.size)}{item.summary ? ` · ${item.summary}` : ""}</small>
        </div>
        <span className="queue-status">{busy ? <span className="progress-spinner" /> : null}{statusLabels[item.status]}</span>
      </div>

      {item.error ? <div className="queue-error">{item.error}</div> : null}

      {item.status === "awaiting_confirmation" && draft ? (
        <div className="queue-editor">
          <label className="queue-wide"><span>资料名称</span><input value={draft.title} onChange={(event) => onResourceChange(item.id, { title: event.target.value })} /></label>
          <label><span>课程</span><select value={draft.courseId} onChange={(event) => onResourceChange(item.id, { courseId: event.target.value })}><option value="">请选择课程</option>{courses.map((course) => <option key={course.id} value={course.id}>{course.name}</option>)}</select></label>
          <label><span>资料类型</span><select value={draft.type} onChange={(event) => onResourceChange(item.id, { type: event.target.value as Resource["type"] })}><option>课件</option><option>作业</option><option>笔记</option><option>通知</option><option>试卷</option><option>其他</option></select></label>
          <label className="queue-wide"><span>标签（用顿号或逗号分隔）</span><input value={draft.tags.join("、")} onChange={(event) => onResourceChange(item.id, { tags: splitTags(event.target.value) })} /></label>
          <div className="queue-evidence queue-wide"><span>资料识别依据 · 置信度 {confidenceLabel(draft.confidence)}</span><p>{draft.evidence || "模型未给出明确依据"}</p></div>

          {task ? (
            <div className="queue-task queue-wide">
              <label className="queue-task-toggle"><input type="checkbox" checked={item.includeTask} onChange={(event) => onToggleTask(item.id, event.target.checked)} />同时保存识别到的 DDL</label>
              {item.includeTask ? <div className="queue-task-grid">
                <label><span>任务名称</span><input value={task.title} onChange={(event) => onTaskChange(item.id, { title: event.target.value })} /></label>
                <label><span>截止时间</span><input type="datetime-local" value={task.dueAt} onChange={(event) => onTaskChange(item.id, { dueAt: event.target.value })} /></label>
                <label><span>课程</span><select value={task.courseId} onChange={(event) => onTaskChange(item.id, { courseId: event.target.value })}><option value="">请选择课程</option>{courses.map((course) => <option key={course.id} value={course.id}>{course.name}</option>)}</select></label>
                <label><span>类型</span><select value={task.type} onChange={(event) => onTaskChange(item.id, { type: event.target.value as Task["type"] })}><option>DDL</option><option>考试</option><option>复习</option></select></label>
              </div> : null}
              {item.includeTask && item.taskMeta ? <div className="queue-evidence"><span>任务识别依据 · 置信度 {confidenceLabel(item.taskMeta.confidence)}</span><p>{item.taskMeta.evidence || "模型未给出明确依据"}</p>{item.taskMeta.questions.length ? <ul>{item.taskMeta.questions.map((question) => <li key={question}>{question}</li>)}</ul> : null}</div> : null}
            </div>
          ) : null}

          <div className="queue-actions queue-wide"><button className="primary-button" onClick={() => onConfirm(item.id)}>确认入库</button><button className="quiet-button" onClick={() => onCancel(item.id)}>取消</button></div>
        </div>
      ) : null}

      {item.status === "queued" || item.status === "processing" ? <div className="queue-actions"><button className="quiet-button" onClick={() => onCancel(item.id)}>取消</button></div> : null}
      {item.status === "failed" ? <div className="queue-actions">{item.failureKind !== "validation" ? <button className="quiet-button" onClick={() => onRetry(item.id)} disabled={running}>{item.failureKind === "storage" ? "重试保存" : "重试识别"}</button> : null}{draft ? <button className="quiet-button" onClick={() => onManual(item.id)}>手动整理</button> : null}<button className="text-button" onClick={() => onRemove(item.id)}>移除</button></div> : null}
      {item.status === "cancelled" ? <div className="queue-actions"><button className="quiet-button" onClick={() => onRetry(item.id)} disabled={running}>重新加入</button><button className="text-button" onClick={() => onRemove(item.id)}>移除</button></div> : null}
      {item.status === "saved" ? <div className="queue-actions"><span className="queue-success">资料与原文件已保存在本机</span><button className="text-button" onClick={() => onRemove(item.id)}>移除</button></div> : null}
    </article>
  );
}

function splitTags(value: string) {
  return [...new Set(value.split(/[、,，]/).map((tag) => tag.trim()).filter(Boolean))].slice(0, 8);
}

function confidenceLabel(confidence: PendingResourceDraft["confidence"]) {
  return confidence === "high" ? "高" : confidence === "medium" ? "中" : "低";
}

function fileMark(name: string) {
  const extension = name.split(".").pop()?.toUpperCase() ?? "FILE";
  return extension.slice(0, 4);
}

function formatBytes(size: number) {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / 1024 / 1024).toFixed(1)} MB`;
}
