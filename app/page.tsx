"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  AppSnapshot,
  Course,
  Resource,
  Task,
  demoSnapshot,
  emptySnapshot,
  loadSnapshot,
  makeId,
  saveSnapshot,
} from "./lib/local-store";

type View = "assistant" | "resources" | "tasks" | "review" | "data";
type ChatMessage = {
  id: string;
  role: "user" | "assistant";
  text: string;
};

const initialMessages: ChatMessage[] = [
  {
    id: "welcome",
    role: "assistant",
    text: "你好，我是你的学习管家。你可以直接说“帮我记下这个DDL”“找数据库的课件”或“安排本周复习”。",
  },
];

const viewLabels: Record<View, string> = {
  assistant: "智能体",
  resources: "资料库",
  tasks: "任务中心",
  review: "复习计划",
  data: "数据管理",
};

const formatDate = (value: string) => {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("zh-CN", {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
};

const formatShortDate = (value: string) => {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("zh-CN", { month: "numeric", day: "numeric" }).format(date);
};

export default function Home() {
  const [view, setView] = useState<View>("assistant");
  const [snapshot, setSnapshot] = useState<AppSnapshot>(emptySnapshot());
  const [ready, setReady] = useState(false);
  const [messages, setMessages] = useState<ChatMessage[]>(initialMessages);
  const [input, setInput] = useState("");
  const [search, setSearch] = useState("");
  const [pendingTask, setPendingTask] = useState<Task | null>(null);
  const [showResourceForm, setShowResourceForm] = useState(false);
  const [showTaskForm, setShowTaskForm] = useState(false);
  const [resourceTitle, setResourceTitle] = useState("");
  const [resourceCourse, setResourceCourse] = useState("");
  const [resourceType, setResourceType] = useState<Resource["type"]>("课件");
  const [taskTitle, setTaskTitle] = useState("");
  const [taskCourse, setTaskCourse] = useState("");
  const [taskDueAt, setTaskDueAt] = useState("2026-08-12T23:59");
  const importInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    loadSnapshot().then((stored) => {
      const next = stored.courses.length ? stored : demoSnapshot();
      setSnapshot(next);
      setReady(true);
      setResourceCourse(next.courses[0]?.id ?? "");
      setTaskCourse(next.courses[0]?.id ?? "");
      if (!stored.courses.length) saveSnapshot(next);
    });
  }, []);

  useEffect(() => {
    if (ready) saveSnapshot(snapshot);
  }, [ready, snapshot]);

  const courseMap = useMemo(
    () => new Map(snapshot.courses.map((course) => [course.id, course])),
    [snapshot.courses],
  );

  const filteredResources = useMemo(() => {
    const keyword = search.trim().toLowerCase();
    if (!keyword) return snapshot.resources;
    return snapshot.resources.filter((resource) => {
      const course = courseMap.get(resource.courseId)?.name ?? "";
      return [resource.title, resource.fileName, course, ...resource.tags]
        .filter(Boolean)
        .join(" ")
        .toLowerCase()
        .includes(keyword);
    });
  }, [courseMap, search, snapshot.resources]);

  const upcomingTasks = snapshot.tasks
    .filter((task) => task.status !== "已完成")
    .sort((a, b) => a.dueAt.localeCompare(b.dueAt));
  const pendingCount = snapshot.resources.filter((resource) => resource.status === "未整理").length;
  const completedCount = snapshot.tasks.filter((task) => task.status === "已完成").length;

  const addAssistantMessage = (text: string) => {
    setMessages((current) => [...current, { id: makeId("message"), role: "assistant", text }]);
  };

  const sendMessage = () => {
    const text = input.trim();
    if (!text) return;
    setMessages((current) => [...current, { id: makeId("message"), role: "user", text }]);
    setInput("");

    if (/DDL|截止|作业|考试/.test(text)) {
      const course = snapshot.courses[0];
      setPendingTask({
        id: makeId("task-draft"),
        title: text.includes("作业") ? "待确认的作业任务" : "待确认的学习任务",
        courseId: course?.id ?? "",
        type: text.includes("考试") ? "考试" : "DDL",
        dueAt: "2026-08-12T23:59",
        status: "未开始",
        priority: "高",
        reminder: "提前3天、1天、2小时",
      });
      addAssistantMessage("我先生成了一条候选任务。当前日期或课程还不明确，确认前请检查并修改卡片中的字段。");
      return;
    }

    if (/找|查|搜索|课件|资料/.test(text)) {
      setSearch(text.replace(/找|查|搜索|课件|资料/g, "").trim());
      setView("resources");
      addAssistantMessage("我已打开资料库，并按你的关键词筛选结果。你可以继续补充课程或资料类型。");
      return;
    }

    if (/复习|计划|考试安排/.test(text)) {
      setView("review");
      addAssistantMessage("好的，我打开复习计划。请先选择课程、考试时间和你方便学习的日期/时间段。");
      return;
    }

    addAssistantMessage("我可以帮你录入 DDL、整理资料、检索课程内容，或根据考试日期安排复习。你想先处理哪一件？");
  };

  const confirmPendingTask = () => {
    if (!pendingTask) return;
    setSnapshot((current) => ({ ...current, tasks: [pendingTask, ...current.tasks] }));
    setPendingTask(null);
    addAssistantMessage("已保存任务，并设置了提前 3 天、1 天和 2 小时的提醒规则。之后可以在任务中心修改。");
  };

  const updateTaskStatus = (taskId: string, status: Task["status"]) => {
    setSnapshot((current) => ({
      ...current,
      tasks: current.tasks.map((task) => (task.id === taskId ? { ...task, status } : task)),
    }));
  };

  const createResource = () => {
    if (!resourceTitle.trim() || !resourceCourse) return;
    const resource: Resource = {
      id: makeId("resource"),
      title: resourceTitle.trim(),
      courseId: resourceCourse,
      type: resourceType,
      tags: [resourceType, "待整理"],
      status: "未整理",
      importedAt: new Date().toISOString().slice(0, 10),
    };
    setSnapshot((current) => ({ ...current, resources: [resource, ...current.resources] }));
    setResourceTitle("");
    setShowResourceForm(false);
  };

  const createTask = () => {
    if (!taskTitle.trim() || !taskCourse || !taskDueAt) return;
    const task: Task = {
      id: makeId("task"),
      title: taskTitle.trim(),
      courseId: taskCourse,
      type: "DDL",
      dueAt: taskDueAt,
      status: "未开始",
      priority: "中",
      reminder: "提前3天、1天、2小时",
    };
    setSnapshot((current) => ({ ...current, tasks: [task, ...current.tasks] }));
    setTaskTitle("");
    setShowTaskForm(false);
  };

  const exportBackup = () => {
    const blob = new Blob([JSON.stringify(snapshot, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `学习管家备份-${new Date().toISOString().slice(0, 10)}.json`;
    link.click();
    URL.revokeObjectURL(url);
  };

  const importBackup = (file?: File) => {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const imported = JSON.parse(String(reader.result)) as AppSnapshot;
        if (!Array.isArray(imported.courses) || !Array.isArray(imported.resources) || !Array.isArray(imported.tasks)) {
          throw new Error("invalid backup");
        }
        setSnapshot(imported);
        addAssistantMessage("备份已载入当前浏览器。请检查课程、资料和任务数量是否符合预期。");
      } catch {
        addAssistantMessage("这个备份文件无法读取。请确认它是学习管家导出的 JSON 备份。");
      }
    };
    reader.readAsText(file);
  };

  const resetDemo = () => {
    const next = demoSnapshot();
    setSnapshot(next);
    addAssistantMessage("示例数据已恢复。你可以在此基础上继续添加自己的课程、资料和任务。");
  };

  return (
    <main className="app-shell">
      <aside className="sidebar">
        <div className="brand-lockup">
          <div className="brand-mark">学</div>
          <div>
            <div className="brand-name">学习管家</div>
            <div className="brand-caption">personal study desk</div>
          </div>
        </div>

        <nav className="main-nav" aria-label="主导航">
          {(Object.keys(viewLabels) as View[]).map((item) => (
            <button
              className={`nav-item ${view === item ? "active" : ""}`}
              key={item}
              onClick={() => setView(item)}
            >
              <span className="nav-dot">{item === "assistant" ? "✦" : item === "resources" ? "▣" : item === "tasks" ? "◷" : item === "review" ? "✓" : "⚙"}</span>
              <span>{viewLabels[item]}</span>
              {item === "tasks" && upcomingTasks.length > 0 ? <span className="nav-count">{upcomingTasks.length}</span> : null}
            </button>
          ))}
        </nav>

        <div className="sidebar-section">
          <div className="section-label">我的课程</div>
          {snapshot.courses.map((course) => (
            <button className="course-row" key={course.id} onClick={() => { setSearch(course.name); setView("resources"); }}>
              <span className={`course-swatch ${course.color}`} />
              <span>{course.name}</span>
              <span className="course-count">{snapshot.resources.filter((resource) => resource.courseId === course.id).length}</span>
            </button>
          ))}
        </div>

        <div className="sidebar-footer">
          <span className="local-indicator" />
          <span>数据保存在本机浏览器</span>
        </div>
      </aside>

      <section className="main-area">
        <header className="topbar">
          <div className="mobile-brand"><span className="brand-mark small">学</span>学习管家</div>
          <div className="breadcrumb">{viewLabels[view]} <span>/</span> {view === "assistant" ? "今天" : "全部内容"}</div>
          <label className="global-search">
            <span>⌕</span>
            <input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              onKeyDown={(event) => { if (event.key === "Enter") setView("resources"); }}
              placeholder="搜索资料、任务或课程"
              aria-label="搜索资料、任务或课程"
            />
          </label>
          <button className="icon-button" title="本地数据管理" onClick={() => setView("data")}>⚙</button>
        </header>

        <div className="content-wrap">
          {view === "assistant" ? (
            <AssistantView
              messages={messages}
              input={input}
              setInput={setInput}
              onSend={sendMessage}
              pendingTask={pendingTask}
              onConfirm={confirmPendingTask}
              onCancel={() => setPendingTask(null)}
              upcomingTasks={upcomingTasks}
              courseMap={courseMap}
              pendingCount={pendingCount}
              completedCount={completedCount}
              onNavigate={setView}
            />
          ) : null}

          {view === "resources" ? (
            <ResourcesView
              resources={filteredResources}
              courseMap={courseMap}
              courses={snapshot.courses}
              search={search}
              onSearch={setSearch}
              showForm={showResourceForm}
              setShowForm={setShowResourceForm}
              title={resourceTitle}
              setTitle={setResourceTitle}
              courseId={resourceCourse}
              setCourseId={setResourceCourse}
              type={resourceType}
              setType={setResourceType}
              onCreate={createResource}
            />
          ) : null}

          {view === "tasks" ? (
            <TasksView
              tasks={upcomingTasks}
              courseMap={courseMap}
              courses={snapshot.courses}
              showForm={showTaskForm}
              setShowForm={setShowTaskForm}
              title={taskTitle}
              setTitle={setTaskTitle}
              courseId={taskCourse}
              setCourseId={setTaskCourse}
              dueAt={taskDueAt}
              setDueAt={setTaskDueAt}
              onCreate={createTask}
              onComplete={(taskId) => updateTaskStatus(taskId, "已完成")}
            />
          ) : null}

          {view === "review" ? <ReviewView courses={snapshot.courses} resources={snapshot.resources} /> : null}

          {view === "data" ? (
            <DataView
              snapshot={snapshot}
              onExport={exportBackup}
              onImport={() => importInputRef.current?.click()}
              onFile={importBackup}
              onReset={resetDemo}
              inputRef={importInputRef}
            />
          ) : null}
        </div>
      </section>
    </main>
  );
}

function AssistantView({
  messages,
  input,
  setInput,
  onSend,
  pendingTask,
  onConfirm,
  onCancel,
  upcomingTasks,
  courseMap,
  pendingCount,
  completedCount,
  onNavigate,
}: {
  messages: ChatMessage[];
  input: string;
  setInput: (value: string) => void;
  onSend: () => void;
  pendingTask: Task | null;
  onConfirm: () => void;
  onCancel: () => void;
  upcomingTasks: Task[];
  courseMap: Map<string, Course>;
  pendingCount: number;
  completedCount: number;
  onNavigate: (view: View) => void;
}) {
  return (
    <div className="assistant-layout">
      <div className="assistant-column">
        <div className="eyebrow">MONDAY, 03 AUGUST 2026</div>
        <h1>今天，把学习<br /><em>理清一点。</em></h1>
        <p className="intro-copy">从一句话开始。整理资料、记下截止日期，或者让计划有一个可执行的起点。</p>

        <div className="chat-panel">
          <div className="chat-head"><span className="online-dot" />学习管家 <span className="head-note">本地优先 · 在线识别可用</span></div>
          <div className="message-list">
            {messages.map((message) => (
              <div className={`message-row ${message.role}`} key={message.id}>
                <div className="avatar">{message.role === "assistant" ? "学" : "我"}</div>
                <div className="message-bubble">{message.text}</div>
              </div>
            ))}
            {pendingTask ? (
              <div className="action-card">
                <div className="action-label">待确认操作 · DDL</div>
                <div className="action-title">{pendingTask.title}</div>
                <div className="action-grid">
                  <div><span>课程</span><strong>{courseMap.get(pendingTask.courseId)?.name || "待选择"}</strong></div>
                  <div><span>截止</span><strong>{formatDate(pendingTask.dueAt)}</strong></div>
                  <div><span>提醒</span><strong>{pendingTask.reminder}</strong></div>
                  <div><span>置信度</span><strong className="confidence">需要确认</strong></div>
                </div>
                <div className="action-buttons"><button className="primary-button" onClick={onConfirm}>确认并保存</button><button className="quiet-button" onClick={onCancel}>取消</button></div>
              </div>
            ) : null}
          </div>
          <div className="composer">
            <input
              value={input}
              onChange={(event) => setInput(event.target.value)}
              onKeyDown={(event) => { if (event.key === "Enter") onSend(); }}
              placeholder="说说你想处理什么…"
              aria-label="输入学习管理需求"
            />
            <button className="attach-button" title="Sprint 2 支持文件上传">＋</button>
            <button className="send-button" onClick={onSend} aria-label="发送">↑</button>
          </div>
        </div>

        <div className="quick-actions">
          <button onClick={() => setInput("帮我记下这个DDL")}>＋ 录入 DDL</button>
          <button onClick={() => onNavigate("resources")}>▣ 整理资料</button>
          <button onClick={() => onNavigate("resources")}>⌕ 查找资料</button>
          <button onClick={() => onNavigate("review")}>✦ 生成复习计划</button>
        </div>
      </div>

      <aside className="dashboard-rail">
        <div className="date-card"><span>08</span><div><b>八月</b><small>2026 · 第 32 周</small></div></div>
        <div className="stat-row"><div><strong>{upcomingTasks.length}</strong><span>待完成任务</span></div><div><strong>{pendingCount}</strong><span>待整理资料</span></div><div><strong>{completedCount}</strong><span>本周完成</span></div></div>
        <div className="rail-section"><div className="section-heading"><span>接下来</span><button onClick={() => onNavigate("tasks")}>查看全部 →</button></div>
          {upcomingTasks.slice(0, 3).map((task) => <TaskMini key={task.id} task={task} course={courseMap.get(task.courseId)} />)}
        </div>
        <div className="tip-card"><span className="tip-kicker">一个小建议</span><p>先把散落的通知交给我，确认后再写入你的学习空间。</p><span className="tip-line" /></div>
      </aside>
    </div>
  );
}

function TaskMini({ task, course }: { task: Task; course?: Course }) {
  return <div className="task-mini"><div className={`task-marker ${task.priority === "高" ? "high" : ""}`} /><div><strong>{task.title}</strong><span>{course?.name ?? "未分类"} · {formatShortDate(task.dueAt)}</span></div><b>{task.type}</b></div>;
}

function ResourcesView({
  resources, courseMap, courses, search, onSearch, showForm, setShowForm, title, setTitle, courseId, setCourseId, type, setType, onCreate,
}: {
  resources: Resource[];
  courseMap: Map<string, Course>;
  courses: Course[];
  search: string;
  onSearch: (value: string) => void;
  showForm: boolean;
  setShowForm: (value: boolean) => void;
  title: string;
  setTitle: (value: string) => void;
  courseId: string;
  setCourseId: (value: string) => void;
  type: Resource["type"];
  setType: (value: Resource["type"]) => void;
  onCreate: () => void;
}) {
  return <div className="page-view"><PageHeader eyebrow="LIBRARY" title="课程资料库" description="让每份资料有位置，也有下一步。" action={<button className="primary-button" onClick={() => setShowForm(!showForm)}>＋ 添加资料</button>} />
    {showForm ? <div className="inline-form"><div className="form-title">新建资料卡片 <span>还没有上传原文件，Sprint 2 接入文件处理</span></div><div className="form-grid"><input value={title} onChange={(event) => setTitle(event.target.value)} placeholder="资料名称" /><select value={courseId} onChange={(event) => setCourseId(event.target.value)}>{courses.map((course) => <option key={course.id} value={course.id}>{course.name}</option>)}</select><select value={type} onChange={(event) => setType(event.target.value as Resource["type"])}><option>课件</option><option>作业</option><option>笔记</option><option>通知</option><option>其他</option></select><button className="primary-button" onClick={onCreate}>保存资料</button></div></div> : null}
    <div className="toolbar"><label className="local-search"><span>⌕</span><input value={search} onChange={(event) => onSearch(event.target.value)} placeholder="搜索标题、课程、标签" /></label><div className="filter-chip">全部课程⌄</div><div className="filter-chip">全部状态⌄</div></div>
    <div className="resource-layout"><div className="resource-list"><div className="list-meta">{resources.length} 份资料 <span>· 本地索引</span></div>{resources.map((resource) => <ResourceListItem key={resource.id} resource={resource} course={courseMap.get(resource.courseId)} />)}{resources.length === 0 ? <EmptyState title="还没有匹配资料" copy="试试换个关键词，或手动添加一张资料卡片。" /> : null}</div><div className="preview-panel"><div className="preview-top"><span>资料预览</span><span className="preview-tag">Sprint 2</span></div><div className="preview-placeholder"><div className="paper-icon">▤</div><strong>文件预览即将接入</strong><span>PDF、Word、PPT 和图片将在下一轮支持预览。</span></div><div className="preview-note">当前 Sprint 先验证资料结构：课程、类型、标签和学习状态。</div></div></div>
  </div>;
}

function ResourceListItem({ resource, course }: { resource: Resource; course?: Course }) {
  return <button className="resource-item"><span className={`file-badge ${resource.type === "作业" ? "coral" : resource.type === "笔记" ? "blue" : ""}`}>{resource.type.slice(0, 1)}</span><span className="resource-main"><strong>{resource.title}</strong><small>{course?.name ?? "未分类"} · {resource.fileName ?? "手动资料卡片"}</small><span className="tag-line">{resource.tags.map((tag) => <em key={tag}>{tag}</em>)}</span></span><span className="resource-status">{resource.status}</span><span className="chevron">›</span></button>;
}

function TasksView({ tasks, courseMap, courses, showForm, setShowForm, title, setTitle, courseId, setCourseId, dueAt, setDueAt, onCreate, onComplete }: { tasks: Task[]; courseMap: Map<string, Course>; courses: Course[]; showForm: boolean; setShowForm: (value: boolean) => void; title: string; setTitle: (value: string) => void; courseId: string; setCourseId: (value: string) => void; dueAt: string; setDueAt: (value: string) => void; onCreate: () => void; onComplete: (id: string) => void; }) {
  return <div className="page-view"><PageHeader eyebrow="TASK DESK" title="任务中心" description="DDL、考试和复习时段，放在同一条时间线上。" action={<button className="primary-button" onClick={() => setShowForm(!showForm)}>＋ 新建任务</button>} />
    {showForm ? <div className="inline-form"><div className="form-title">新建 DDL <span>默认提醒：提前 3 天、1 天、2 小时</span></div><div className="form-grid task-form"><input value={title} onChange={(event) => setTitle(event.target.value)} placeholder="任务名称" /><select value={courseId} onChange={(event) => setCourseId(event.target.value)}>{courses.map((course) => <option key={course.id} value={course.id}>{course.name}</option>)}</select><input type="datetime-local" value={dueAt} onChange={(event) => setDueAt(event.target.value)} /><button className="primary-button" onClick={onCreate}>保存任务</button></div></div> : null}
    <div className="task-list-wrap"><div className="task-list-head"><span>未完成任务 · {tasks.length}</span><div><span className="legend-dot high" />高优先级 <span className="legend-dot" />普通</div></div>{tasks.map((task) => <div className="task-row" key={task.id}><div className={`task-marker ${task.priority === "高" ? "high" : ""}`} /><div className="task-row-main"><strong>{task.title}</strong><span>{courseMap.get(task.courseId)?.name ?? "未分类"} · {task.type} · {task.reminder}</span></div><time>{formatDate(task.dueAt)}</time><span className={`status-pill ${task.status === "进行中" ? "working" : ""}`}>{task.status}</span><button className="complete-button" onClick={() => onComplete(task.id)}>完成</button></div>)}{tasks.length === 0 ? <EmptyState title="所有任务都完成了" copy="可以去复习计划，安排下一步学习。" /> : null}</div>
  </div>;
}

function ReviewView({ courses, resources }: { courses: Course[]; resources: Resource[] }) {
  const [courseId, setCourseId] = useState(courses[0]?.id ?? "");
  const [availability, setAvailability] = useState("工作日晚上 19:00–21:00");
  const [generated, setGenerated] = useState(false);
  const course = courses.find((item) => item.id === courseId);
  const count = resources.filter((resource) => resource.courseId === courseId).length;
  return <div className="page-view"><PageHeader eyebrow="REVIEW STUDIO" title="复习计划" description="先告诉我你什么时候有空，再把资料排成可以完成的节奏。" action={<span className="soft-badge">AI 草案 · 需确认</span>} />
    <div className="review-layout"><div className="review-form-card"><div className="card-kicker">STEP 01 · 先说你的时间</div><h2>为哪门课准备？</h2><select value={courseId} onChange={(event) => setCourseId(event.target.value)}>{courses.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select><label>考试或复习截止时间<input type="datetime-local" defaultValue="2026-08-20T09:00" /></label><label>你什么时候方便学习？<input value={availability} onChange={(event) => setAvailability(event.target.value)} placeholder="例如：周一到周五晚上" /></label><div className="availability-chips"><button onClick={() => setAvailability("工作日晚上 19:00–21:00")}>工作日晚上</button><button onClick={() => setAvailability("周末上午 09:00–12:00")}>周末上午</button><button onClick={() => setAvailability("每天 60 分钟")}>每天1小时</button></div><button className="primary-button wide" onClick={() => setGenerated(true)}>生成计划草案</button><small className="form-help">当前课程已有 {count} 份资料，生成前还会参考“待复习”状态。</small></div><div className="plan-preview-card">{generated ? <><div className="plan-head"><div><div className="card-kicker">STEP 02 · 草案</div><h2>{course?.name ?? "课程"} · 复习节奏</h2></div><span className="soft-badge">{availability}</span></div><PlanItem date="8月13日" title="梳理第一章核心概念" duration="45分钟" /><PlanItem date="8月14日" title="完成一组基础题" duration="45分钟" /><PlanItem date="8月15日" title="整理错题与公式" duration="30分钟" /><div className="plan-actions"><button className="primary-button">确认保存</button><button className="quiet-button" onClick={() => setGenerated(false)}>重新生成</button></div></> : <div className="empty-plan"><div className="plan-orbit">✦</div><h2>计划会出现在这里</h2><p>选择课程并告诉我你有空的时间，先生成一份可调整的草案。</p></div>}</div></div>
  </div>;
}

function PlanItem({ date, title, duration }: { date: string; title: string; duration: string }) { return <div className="plan-item"><time>{date}</time><div><strong>{title}</strong><span>关联资料 · 可调整</span></div><b>{duration}</b></div>; }

function DataView({ snapshot, onExport, onImport, onFile, onReset, inputRef }: { snapshot: AppSnapshot; onExport: () => void; onImport: () => void; onFile: (file?: File) => void; onReset: () => void; inputRef: React.RefObject<HTMLInputElement | null>; }) {
  return <div className="page-view"><PageHeader eyebrow="LOCAL SPACE" title="数据管理" description="你的学习空间默认留在当前浏览器里。" action={<span className="local-badge"><span className="local-indicator" />本地存储正常</span>} /><div className="data-grid"><div className="data-card primary-data"><div className="card-kicker">LOCAL SNAPSHOT</div><h2>这是你的个人学习空间</h2><p>课程、资料、任务和对话数据不会自动上传云端。使用备份文件可以在浏览器或设备之间迁移。</p><div className="data-stats"><div><strong>{snapshot.courses.length}</strong><span>门课程</span></div><div><strong>{snapshot.resources.length}</strong><span>份资料</span></div><div><strong>{snapshot.tasks.length}</strong><span>条任务</span></div></div><div className="data-actions"><button className="primary-button" onClick={onExport}>下载本地备份</button><button className="quiet-button" onClick={onImport}>恢复备份</button><input ref={inputRef} type="file" accept="application/json" hidden onChange={(event) => onFile(event.target.files?.[0])} /></div></div><div className="data-card"><div className="card-kicker">CURRENT LIMITS</div><h3>Sprint 1 本地能力</h3><ul className="check-list"><li><span>✓</span>刷新页面后数据仍保留</li><li><span>✓</span>备份为 JSON 文件</li><li><span>✓</span>无网络可浏览和编辑</li><li><span className="pending-mark">→</span>文件原件存储将在 Sprint 2 接入</li><li><span className="pending-mark">→</span>模型识别将在 Sprint 2 接入</li></ul><button className="text-button" onClick={onReset}>恢复示例数据</button></div></div></div>;
}

function PageHeader({ eyebrow, title, description, action }: { eyebrow: string; title: string; description: string; action?: React.ReactNode }) { return <div className="page-header"><div><div className="eyebrow">{eyebrow}</div><h1>{title}</h1><p>{description}</p></div>{action ? <div className="page-header-action">{action}</div> : null}</div>; }

function EmptyState({ title, copy }: { title: string; copy: string }) { return <div className="empty-state"><div className="empty-symbol">＋</div><strong>{title}</strong><span>{copy}</span></div>; }
