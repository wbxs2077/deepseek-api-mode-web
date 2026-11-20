// 逐块喂入文本，按行切出 `data:` 载荷。分块可以落在任意位置。
// atEof marks a final data line that had no line ending.
export function createSseParser(onData: (data: string, atEof: boolean) => void) {
  let buf = '';
  const emit = (line: string, atEof = false) => {
    if (line.startsWith('data:')) onData(line.slice(5).trim(), atEof);
  };
  return {
    feed(chunk: string) {
      buf += chunk;
      let i: number;
      while ((i = buf.indexOf('\n')) !== -1) {
        emit(buf.slice(0, i).replace(/\r$/, ''));
        buf = buf.slice(i + 1);
      }
    },
    end() {
      emit(buf.replace(/\r$/, ''), true);
      buf = '';
    },
  };
}
