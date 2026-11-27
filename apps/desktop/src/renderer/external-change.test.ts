import { describe, expect, it } from "vitest";
import { changeStateOf } from "./external-change";

const saved = { mtimeMs: 1000, ignoredMtime: null as number | null, ignoredMissing: false };

describe("外部改动判定", () => {
  it("mtime 没变：不标记", () => {
    expect(changeStateOf(saved, { exists: true, mtimeMs: 1000 })).toEqual({ externalChange: false, missing: false });
  });

  it("mtime 变了：标记，但不认为文件缺失", () => {
    expect(changeStateOf(saved, { exists: true, mtimeMs: 2000 })).toEqual({ externalChange: true, missing: false });
  });

  it("文件被删：标记缺失", () => {
    expect(changeStateOf(saved, { exists: false, mtimeMs: 0 })).toEqual({ externalChange: true, missing: true });
  });

  it("保留当前版本后，同一次 mtime 不再提示", () => {
    const kept = { ...saved, ignoredMtime: 2000 };
    expect(changeStateOf(kept, { exists: true, mtimeMs: 2000 })).toEqual({ externalChange: false, missing: false });
    // 又改了一次：重新提示
    expect(changeStateOf(kept, { exists: true, mtimeMs: 3000 })).toEqual({ externalChange: true, missing: false });
  });

  it("文件回到保存时的 mtime：忽略记录失效，保持干净", () => {
    const kept = { ...saved, ignoredMtime: 2000 };
    expect(changeStateOf(kept, { exists: true, mtimeMs: 1000 })).toEqual({ externalChange: false, missing: false });
  });

  it("保留过「已被删除」：不再提示，直到文件重新出现", () => {
    const kept = { ...saved, ignoredMtime: 2000, ignoredMissing: true };
    expect(changeStateOf(kept, { exists: false, mtimeMs: 0 })).toEqual({ externalChange: false, missing: true });
    expect(changeStateOf(kept, { exists: true, mtimeMs: 1000 })).toEqual({ externalChange: false, missing: false });
  });
});
