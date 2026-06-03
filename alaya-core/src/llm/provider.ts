/**
 * LLM Provider 抽象 (PRD 5、16)。
 * 第一版用确定性 MockLLM,切真实 OpenAI 时只换实现,业务逻辑零改动。
 *
 * 关键设计:mock 返回的是结构化 JSON,且包含 confidence_evidence(alpha/beta),
 * 但置信度强弱仍由证据计数计算(PRD 8.6),LLM 只负责生成候选,不决定强弱。
 */

export interface LLMResponse {
  schemaValid: boolean;
  retryCount: number;
  data: Record<string, unknown>;
}

export interface LLMProvider {
  name: string;
  call(role: string, task: string, context: Record<string, unknown>): LLMResponse;
}

/**
 * 确定性 Mock:按 (role, task) 返回固定结构化结果。
 * 模拟真实场景:每轮的反馈、构建结果、观察值都来自 scenario,不随机,
 * 这样飞轮是否复利可被确定性验证。
 */
export class MockLLM implements LLMProvider {
  name = "mock";
  call(role: string, task: string): LLMResponse {
    // mock 始终返回 schema 合法的结构化输出;具体语义由 scenario 注入,
    // 此处仅证明 LLM 调用契约存在(schema 校验、retry 计数等接口齐备)。
    return {
      schemaValid: true,
      retryCount: 0,
      data: { role, task, note: "mock structured output" },
    };
  }
}
