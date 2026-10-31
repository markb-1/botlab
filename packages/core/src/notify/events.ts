/** Order events the notifier consumes (OrderService calls these; implementations must never throw). */

export interface OrderFillEvent {
  botId: string;
  botName: string;
  exchange: string;
  side: 'BUY' | 'SELL';
  symbol: string;
  market?: string;
  outcome?: string;
  quantity: number;
  price: number;
  notionalUsd: number;
  simulated: boolean;
}

export interface OrderRejectedEvent {
  botId: string;
  botName: string;
  failedCheck: string;
  reason: string;
  simulated: boolean;
}

export interface OrderEventSink {
  orderFilled(e: OrderFillEvent): void;
  orderRejected(e: OrderRejectedEvent): void;
}
