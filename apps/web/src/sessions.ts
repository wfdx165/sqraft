/**
 * 会话（Session）持久化：IndexedDB，纯本地。
 * 会话 = 对话消息历史 + 自动标题；模型是全局设置，不随会话保存。
 */

export type ContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } };

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | ContentPart[] | null;
  tool_calls?: { id: string; function: { name: string; arguments: string } }[];
  tool_call_id?: string;
}

export interface Session {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  messages: ChatMessage[];
}

export interface SessionMeta {
  id: string;
  title: string;
  updatedAt: number;
}

const DB_NAME = "sqraft";
const DB_VERSION = 1;
const STORE = "sessions";

let dbPromise: Promise<IDBDatabase> | null = null;

function openDB(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const store = db.createObjectStore(STORE, { keyPath: "id" });
        store.createIndex("updatedAt", "updatedAt");
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("无法打开 IndexedDB"));
  });
  return dbPromise;
}

function requestToPromise<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("IndexedDB 请求失败"));
  });
}

export async function loadSessionList(): Promise<SessionMeta[]> {
  const db = await openDB();
  const tx = db.transaction(STORE, "readonly");
  const all = await requestToPromise(tx.objectStore(STORE).getAll() as IDBRequest<Session[]>);
  return all
    .map((s) => ({ id: s.id, title: s.title, updatedAt: s.updatedAt }))
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function loadSession(id: string): Promise<Session | undefined> {
  const db = await openDB();
  const tx = db.transaction(STORE, "readonly");
  return await requestToPromise(tx.objectStore(STORE).get(id) as IDBRequest<Session | undefined>);
}

export async function saveSession(session: Session): Promise<void> {
  const db = await openDB();
  const tx = db.transaction(STORE, "readwrite");
  tx.objectStore(STORE).put(session);
  await new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error("写入会话失败"));
  });
}

export async function deleteSession(id: string): Promise<void> {
  const db = await openDB();
  const tx = db.transaction(STORE, "readwrite");
  tx.objectStore(STORE).delete(id);
  await new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error("删除会话失败"));
  });
}

/** 取首条用户消息前 20 字作为自动标题。 */
export function autoTitle(text: string): string {
  const clean = text.replace(/\s+/g, " ").trim();
  return clean.length > 20 ? `${clean.slice(0, 20)}…` : clean || "新对话";
}

/** 会话时间：今天显示 HH:MM，否则显示 月/日。 */
export function formatSessionTime(ts: number): string {
  const d = new Date(ts);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  if (sameDay) return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  return `${d.getMonth() + 1}/${d.getDate()}`;
}
