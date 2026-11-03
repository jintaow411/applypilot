/** mammoth 的最小类型声明（只需要 extractRawText，零 @types 依赖）。 */
declare module 'mammoth' {
  export interface ExtractRawTextResult {
    value: string;
    messages: Array<{ type: string; message: string }>;
  }
  export function extractRawText(input: { arrayBuffer: ArrayBuffer }): Promise<ExtractRawTextResult>;
}
