/**
 * AI Provider 配置（纯本地，localStorage）。
 * 预置 OpenCode；用户可添加任意 OpenAI 兼容接入点。
 */
import { reactive } from "vue";

export interface Provider {
  id: string;
  name: string;
  baseUrl: string;
  apiKey: string;
  models: string[];
}

export interface AIConfig {
  providers: Provider[];
  selectedProviderId: string | null;
  selectedModel: string | null;
}

const STORAGE_KEY = "sqraft.ai";

export const OPENCODE_TEMPLATE: Omit<Provider, "id"> = {
  name: "OpenCode",
  baseUrl: "https://opencode.ai/zen/go/v1",
  apiKey: "",
  models: ["glm-5.3", "glm-5.3-flash", "kimi-k3"],
};

function defaultConfig(): AIConfig {
  // 迁移旧的单端点配置（sqraft.baseUrl / apiKey / model）
  const legacyBase = localStorage.getItem("sqraft.baseUrl");
  if (legacyBase) {
    const provider: Provider = {
      id: "legacy",
      name: "我的接入点",
      baseUrl: legacyBase,
      apiKey: localStorage.getItem("sqraft.apiKey") ?? "",
      models: [localStorage.getItem("sqraft.model")].filter(Boolean) as string[],
    };
    return {
      providers: [provider],
      selectedProviderId: provider.id,
      selectedModel: provider.models[0] ?? null,
    };
  }
  const preset: Provider = { ...OPENCODE_TEMPLATE, id: "opencode" };
  return {
    providers: [preset],
    selectedProviderId: preset.id,
    selectedModel: preset.models[0] ?? null,
  };
}

function load(): AIConfig {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return JSON.parse(raw) as AIConfig;
  } catch {
    /* 损坏则回退默认 */
  }
  return defaultConfig();
}

export const ai = reactive<AIConfig>(load());

export function persist(): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(ai));
}

export function providerOf(id: string | null): Provider | undefined {
  return ai.providers.find((p) => p.id === id);
}

export function selectedProvider(): Provider | undefined {
  return providerOf(ai.selectedProviderId);
}

export function hasModels(): boolean {
  return ai.providers.some((p) => p.models.length > 0);
}

export function addProvider(input: Omit<Provider, "id">): Provider {
  const provider: Provider = { ...input, id: crypto.randomUUID() };
  ai.providers.push(provider);
  const current = selectedProvider();
  if (!ai.selectedModel || !current || !current.models.includes(ai.selectedModel)) {
    ai.selectedProviderId = provider.id;
    ai.selectedModel = provider.models[0] ?? null;
  }
  persist();
  return provider;
}

export function updateProvider(id: string, patch: Partial<Omit<Provider, "id">>): void {
  const provider = providerOf(id);
  if (!provider) return;
  Object.assign(provider, patch);
  if (ai.selectedProviderId === id && ai.selectedModel && !provider.models.includes(ai.selectedModel)) {
    ai.selectedModel = provider.models[0] ?? null;
  }
  persist();
}

export function removeProvider(id: string): void {
  ai.providers = ai.providers.filter((p) => p.id !== id);
  if (ai.selectedProviderId === id) {
    const next = ai.providers[0];
    ai.selectedProviderId = next?.id ?? null;
    ai.selectedModel = next?.models[0] ?? null;
  }
  persist();
}

export function selectModel(providerId: string, model: string): void {
  ai.selectedProviderId = providerId;
  ai.selectedModel = model;
  persist();
}

/** 尝试从 OpenAI 兼容端点拉取模型列表（GET {baseUrl}/models）。 */
export async function fetchProviderModels(baseUrl: string, apiKey: string): Promise<string[]> {
  const headers: Record<string, string> = {};
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  const resp = await fetch(`${baseUrl.replace(/\/$/, "")}/models`, { headers });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}: ${(await resp.text()).slice(0, 160)}`);
  const data = (await resp.json()) as unknown;
  const items: unknown[] = Array.isArray(data) ? data : ((data as { data?: unknown[] }).data ?? []);
  const ids = items
    .map((m) => (typeof m === "string" ? m : (m as { id?: string; name?: string }).id ?? (m as { name?: string }).name))
    .filter((v): v is string => typeof v === "string" && v.length > 0);
  if (ids.length === 0) throw new Error("端点没有返回模型");
  return [...new Set(ids)];
}
