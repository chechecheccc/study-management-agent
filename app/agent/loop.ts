// Agent 循环：感知 → 模型决策 → 工具执行 → 观察 → 再决策，直到任务完成。
// 这是整个系统的核心，与 React / DOM 完全解耦：
//   - step()               由调用方实现（生产环境 = /api/agent/step，测试 = mock）
//   - execute()            由调用方实现（前端注入本地数据层的读写）
//   - requestConfirmation  写操作触发人在回路确认，循环挂起等待用户决定
// 通过 async generator 逐事件输出，UI 层可以实时渲染"思考轨迹"。
import type { AgentStepResponse, AgentToolCall, AgentWireMessage } from "./protocol.ts";
import { MAX_TOOL_RESULT_CHARS } from "./protocol.ts";
import { getToolSpec } from "./tools.ts";

export type HistoryMessage = { role: "user" | "assistant"; content: string };

export type ToolExecutionResult = {
  ok: boolean;
  summary: string;
  data?: unknown;
};

export type ConfirmationDecision = {
  approved: boolean;
  arguments?: Record<string, unknown>;
};

export type LoopEvent =
  | { type: "step"; step: number }
  | { type: "tool_call"; call: AgentToolCall }
  | { type: "confirmation"; call: AgentToolCall }
  | { type: "tool_result"; call: AgentToolCall; result: ToolExecutionResult; confirmed: boolean | null }
  | { type: "message"; content: string }
  | { type: "done"; reason: "completed" | "max_steps" | "aborted" | "error"; error?: string };

export type AgentLoopDeps = {
  goal: string;
  history: HistoryMessage[];
  step: (messages: AgentWireMessage[], signal?: AbortSignal) => Promise<AgentStepResponse>;
  execute: (call: AgentToolCall) => Promise<ToolExecutionResult>;
  requestConfirmation: (call: AgentToolCall) => Promise<ConfirmationDecision>;
  maxSteps?: number;
  signal?: AbortSignal;
};

export const DEFAULT_MAX_STEPS = 8;

export async function* runAgentLoop(deps: AgentLoopDeps): AsyncGenerator<LoopEvent, void> {
  const maxSteps = deps.maxSteps ?? DEFAULT_MAX_STEPS;
  const messages: AgentWireMessage[] = [
    ...deps.history.map((message) => ({ role: message.role, content: message.content })),
    { role: "user", content: deps.goal },
  ];
  // 护栏：同一轮里"相同工具 + 相同参数"的只读调用只真正执行一次，之后复用结果。
  // 模型有时会重复查询（尤其换了模型后行为不同），这层保证不浪费时间和额度。
  const completedReadCalls = new Map<string, ToolExecutionResult>();

  for (let stepIndex = 1; stepIndex <= maxSteps; stepIndex += 1) {
    if (deps.signal?.aborted) {
      yield { type: "done", reason: "aborted" };
      return;
    }

    yield { type: "step", step: stepIndex };

    let response: AgentStepResponse;
    try {
      response = await deps.step(messages, deps.signal);
    } catch (error) {
      yield { type: "done", reason: "error", error: errorMessage(error) };
      return;
    }

    if (response.type === "message") {
      messages.push({ role: "assistant", content: response.content });
      yield { type: "message", content: response.content };
      yield { type: "done", reason: "completed" };
      return;
    }

    if (!response.calls.length) {
      yield { type: "done", reason: "error", error: "模型返回了空的工具调用。" };
      return;
    }

    const wireCalls = response.calls.map((call) => ({
      id: call.id,
      type: "function" as const,
      function: { name: call.name, arguments: JSON.stringify(call.arguments) },
    }));
    messages.push({ role: "assistant", content: response.content, tool_calls: wireCalls });

    for (let callIndex = 0; callIndex < response.calls.length; callIndex += 1) {
      let call = response.calls[callIndex];
      const spec = getToolSpec(call.name);
      yield { type: "tool_call", call };

      if (!spec) {
        const result: ToolExecutionResult = { ok: false, summary: `未知工具：${call.name}` };
        pushToolResult(messages, call, result);
        yield { type: "tool_result", call, result, confirmed: null };
        continue;
      }

      if (spec.requiresConfirmation) {
        yield { type: "confirmation", call };
        let decision: ConfirmationDecision;
        try {
          decision = await deps.requestConfirmation(call);
        } catch {
          decision = { approved: false };
        }
        if (!decision.approved) {
          const result: ToolExecutionResult = {
            ok: false,
            summary: "用户取消了这次写入操作。不要重复尝试同一调用，请询问用户想如何调整。",
          };
          pushToolResult(messages, call, result);
          yield { type: "tool_result", call, result, confirmed: false };
          continue;
        }
        if (decision.arguments) {
          call = { ...call, arguments: { ...call.arguments, ...decision.arguments } };
          wireCalls[callIndex].function.arguments = JSON.stringify(call.arguments);
        }
      }

      let result: ToolExecutionResult;
      const cacheKey = `${call.name}:${JSON.stringify(call.arguments)}`;
      const cached = spec.requiresConfirmation ? undefined : completedReadCalls.get(cacheKey);
      if (cached) {
        result = { ok: cached.ok, summary: `${cached.summary}（同一查询已执行过，直接复用结果，请勿重复调用）`, data: cached.data };
      } else {
        try {
          result = await deps.execute(call);
        } catch (error) {
          result = { ok: false, summary: errorMessage(error) };
        }
        if (!spec.requiresConfirmation && result.ok) completedReadCalls.set(cacheKey, result);
      }
      pushToolResult(messages, call, result);
      yield { type: "tool_result", call, result, confirmed: spec.requiresConfirmation ? true : null };
    }
  }

  yield {
    type: "message",
    content: "这件事比我预期的更复杂，我先停在这里，避免做出不可靠的操作。你可以补充信息后再让我继续。",
  };
  yield { type: "done", reason: "max_steps" };
}

function pushToolResult(messages: AgentWireMessage[], call: AgentToolCall, result: ToolExecutionResult) {
  const payload = JSON.stringify({
    ok: result.ok,
    summary: result.summary,
    data: result.data ?? null,
  });
  messages.push({
    role: "tool",
    tool_call_id: call.id,
    content: payload.slice(0, MAX_TOOL_RESULT_CHARS),
  });
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : "未知错误";
}

