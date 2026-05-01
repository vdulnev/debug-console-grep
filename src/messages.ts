export interface ParsedFlags {
    pattern: string;
    before: number;
    after: number;
}

export type HostMsg =
    | { type: 'state'; total: number; firstAvailable: number; partial: string }
    | {
          type: 'cleared';
          total: number;
          firstAvailable: number;
          partial: string;
      }
    | { type: 'range'; requestId: number; from: number; lines: string[] }
    | {
          type: 'matches';
          requestId: number;
          pattern: string;
          before: number;
          after: number;
          matches: number[];
          visible: number[];
      };

export type WebviewMsg =
    | { type: 'log'; data: string }
    | { type: 'ready' }
    | { type: 'set-wrap'; value: boolean }
    | { type: 'set-autoscroll'; value: boolean }
    | { type: 'request-range'; requestId: number; from: number; to: number }
    | {
          type: 'request-matches';
          requestId: number;
          pattern: string;
          before: number;
          after: number;
      }
    | { type: 'clear' };
