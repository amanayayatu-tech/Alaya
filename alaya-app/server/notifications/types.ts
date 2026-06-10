export type AlayaEventType =
  | "gate_opened"
  | "gate_resolved"
  | "review_digest"
  | "review_summary"
  | "safety_mode"
  | "llm_budget_exceeded"
  | "cycle_completed"
  | "knowledge_promoted";

export interface AlayaEvent {
  type: AlayaEventType;
  projectId: string;
  title: string;
  body: string;
  gateId?: string;
  gateType?: "direction" | "meaning" | "risk";
  isBlocking?: boolean;
  actionUrl?: string;
  meta?: Record<string, string>;
}

export interface CardButton {
  text: string;
  type: "primary" | "default" | "danger";
  callbackData: string;
}

export interface AlayaCard {
  title?: { text: string; color?: string };
  body: string;
  buttons?: CardButton[][];
  footer?: string;
}

export interface MessageRef {
  chatId: string;
  messageId: number;
  userId?: string;
}

export type SentMessage = MessageRef;

export type CallbackHandler = (
  callbackId: string,
  data: string,
  ref: MessageRef,
) => Promise<void>;

export interface MessagingPlatform {
  name(): string;
  sendText(chatId: string, text: string): Promise<void>;
  sendCard(chatId: string, card: AlayaCard): Promise<SentMessage>;
  editCard(ref: MessageRef, card: AlayaCard): Promise<void>;
  answerCallback(callbackId: string, text?: string): Promise<void>;
  onCallbackQuery(handler: CallbackHandler): void;
  sendTyping?(chatId: string): Promise<void>;
  start(): Promise<void>;
  stop(): Promise<void>;
}
