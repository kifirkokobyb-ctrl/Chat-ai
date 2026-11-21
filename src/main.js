import { CreateMLCEngine } from "@mlc-ai/web-llm";
import "./style.css";

const BUCKET_ID = "Skilbanan/SmolLM2-360M-Instruct-q0f16-MLC-bucket";
const MODEL_ID = "SmolLM2-360M-Instruct-q0f16-MLC";
const LIST_URL = `https://huggingface.co/api/buckets/${BUCKET_ID}/tree?recursive=true`;
const FILE_BASE = `https://huggingface.co/buckets/${BUCKET_ID}/resolve/`;
const MODEL_LIB_FILE = "SmolLM2-360M-Instruct-q0f16_cs1k-webgpu.wasm";
const MODEL_LIB_URL = `https://raw.githubusercontent.com/mlc-ai/binary-mlc-llm-libs/main/web-llm-models/v0_2_87/base/${MODEL_LIB_FILE}`;
const MODEL_CACHE = "smollm2-model-cache-v3";

const statusEl = document.querySelector("#status");
const messagesEl = document.querySelector("#messages");
const promptEl = document.querySelector("#prompt");
const sendEl = document.querySelector("#send");
const downloadBtn = document.querySelector("#downloadModel");
const loadBtn = document.querySelector("#loadModel");
const panel = document.querySelector("#downloadPanel");
const progressEl = document.querySelector("#downloadProgress");
const percentEl = document.querySelector("#downloadPercent");
const labelEl = document.querySelector("#downloadLabel");
const detailEl = document.querySelector("#downloadDetail");
const cancelBtn = document.querySelector("#cancelDownload");

let engine = null;
let history = [];
let busy = false;
let downloadController = null;
let downloadFinished = false;

function setStatus(text, mode = "") {
  statusEl.className = `status ${mode}`;
  statusEl.querySelector("span").textContent = text;
}
function formatBytes(n) {
  if (!Number.isFinite(n)) return "—";
  const units = ["Б", "КБ", "МБ", "ГБ"];
  let i = 0;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(i ? 1 : 0)} ${units[i]}`;
}
function setDownloadProgress(done, total, fileName) {
  const pct = total > 0 ? Math.min(100, Math.floor(done / total * 100)) : 0;
  progressEl.value = pct;
  percentEl.textContent = `${pct}%`;
  labelEl.textContent = "Скачивание модели";
  detailEl.textContent = `${fileName} · ${formatBytes(done)} / ${formatBytes(total)}`;
}
function addMessage(role, content = "") {
  const item = document.createElement("article");
  item.className = `message ${role}`;
  const avatar = document.createElement("div");
  avatar.className = "avatar";
  avatar.textContent = role === "user" ? "Вы" : "✦";
  const body = document.createElement("div");
  body.className = "bubble";
  const who = document.createElement("div");
  who.className = "speaker";
  who.textContent = role === "user" ? "Вы" : "SmolLM";
  const text = document.createElement("div");
  text.className = "message-text";
  text.textContent = content;
  body.append(who, text);
  item.append(avatar, body);
  messagesEl.append(item);
  messagesEl.scrollTop = messagesEl.scrollHeight;
  return text;
}
function safeModelPath(path) {
  const clean = path.replace(/^\/+/, "");
  if (!clean || clean.split("/").some(part => part === ".." || part === ".")) {
    throw new Error(`Недопустимый путь файла: ${path}`);
  }
  return clean;
}
function localModelUrl(path) {
  const clean = path.split("/").map(encodeURIComponent).join("/");
  return new URL(`${import.meta.env.BASE_URL}model-files/${clean}`, location.origin).href;
}
async function getCache() {
  return await caches.open(MODEL_CACHE);
}
async function isAlreadyDownloaded() {
  const cache = await getCache();
  const root = localStorage.getItem("smollm_model_root") || "";
  const config = await cache.match(localModelUrl(`${root}mlc-chat-config.json`));
  const tokenizer = await cache.match(localModelUrl(`${root}tokenizer.json`));
  const lib = await cache.match(localModelUrl("__model_lib__.wasm"));
  return !!(config && tokenizer && lib);
}
async function listBucketFiles(signal) {
  const response = await fetch(LIST_URL, { signal, mode: "cors", credentials: "omit" });
  if (!response.ok) throw new Error(`Hugging Face вернул ${response.status} при чтении списка файлов.`);
  let entries = await response.json();
  // The API normally returns the whole recursive listing in one page.
  // Follow a Link header if pagination is enabled for this bucket.
  const link = response.headers.get("Link");
  const next = link?.split(",").map(x => x.trim()).find(x => /rel="?next"?/.test(x));
  if (next) {
    const match = next.match(/<([^>]+)>/);
    if (match) {
      const more = await fetch(match[1], { signal, mode: "cors", credentials: "omit" });
      if (more.ok) entries = entries.concat(await more.json());
    }
  }
  return entries.filter(x => x.type === "file" && typeof x.path === "string" && Number(x.size) >= 0);
}
async function cacheResponseFromUrl(remoteUrl, aliasUrl, signal, onBytes) {
  const response = await fetch(remoteUrl, { signal, mode: "cors", credentials: "omit" });
  if (!response.ok) throw new Error(`Не удалось скачать файл (${response.status}): ${remoteUrl}`);
  const total = Number(response.headers.get("content-length")) || 0;
  if (!response.body) {
    const blob = await response.blob();
    const cache = await getCache();
    await cache.put(aliasUrl, new Response(blob, { headers: response.headers }));
    onBytes(blob.size, total || blob.size);
    return blob.size;
  }
  const [forCache, forProgress] = response.body.tee();
  const cache = await getCache();
  const cachePromise = cache.put(aliasUrl, new Response(forCache, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers
  }));
  const reader = forProgress.getReader();
  let received = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.byteLength;
      onBytes(received, total);
    }
    await cachePromise;
    return received;
  } catch (e) {
    reader.cancel().catch(() => {});
    throw e;
  }
}
async function downloadModel() {
  if (downloadController) return;
  downloadController = new AbortController();
  const signal = downloadController.signal;
  downloadBtn.disabled = true;
  cancelBtn.hidden = false;
  panel.hidden = false;
  loadBtn.disabled = true;
  progressEl.value = 0;
  percentEl.textContent = "0%";
  setStatus("Проверяю модель…", "working");
  try {
    if (!("caches" in window) || !("serviceWorker" in navigator)) {
      throw new Error("Этот браузер не поддерживает нужное хранилище PWA. Открой приложение в актуальном Chrome.");
    }
    const persisted = await navigator.storage?.persist?.();
    const estimate = await navigator.storage?.estimate?.();
    const files = await listBucketFiles(signal);
    if (!files.length) throw new Error("В публичном Bucket не найдено файлов. Проверь содержимое хранилища.");
    const configFile = files.find(f => f.path.endsWith("mlc-chat-config.json"));
    const tokenizerFile = files.find(f => f.path.endsWith("tokenizer.json"));
    if (!configFile || !tokenizerFile) {
      throw new Error("В Bucket не найдены mlc-chat-config.json и/или tokenizer.json. Возможно, файлы лежат во вложенной папке или это не WebLLM-модель.");
    }
    // Keep relative directory structure. If config is in a nested folder, use that folder as model root.
    const rootPrefix = configFile.path.slice(0, configFile.path.lastIndexOf("/") + 1);
    if (!tokenizerFile.path.startsWith(rootPrefix)) {
      throw new Error("tokenizer.json находится не в той же папке, что mlc-chat-config.json.");
    }
    const modelFiles = files.filter(f => f.path.startsWith(rootPrefix));
    const selected = modelFiles.map(f => ({ ...f, relativePath: f.path.slice(rootPrefix.length) }));
    const wasmInBucket = selected.find(f => f.relativePath.endsWith(".wasm"));
    const modelLibRemote = wasmInBucket
      ? `${FILE_BASE}${wasmInBucket.path.split("/").map(encodeURIComponent).join("/")}`
      : MODEL_LIB_URL;
    const modelLibSize = wasmInBucket?.size || 0;
    const total = selected.reduce((sum, f) => sum + Number(f.size || 0), modelLibSize);
    const storage = await navigator.storage?.estimate?.();
    if (storage?.quota && storage.quota - (storage.usage || 0) < total * 1.1) {
      throw new Error(`Недостаточно места в хранилище браузера. Нужно примерно ${formatBytes(total)}, доступно ${formatBytes(storage.quota - (storage.usage || 0))}.`);
    }
    const cache = await getCache();
    let completed = 0;
    for (const file of selected) {
      if (signal.aborted) throw new DOMException("Загрузка отменена", "AbortError");
      const relative = safeModelPath(file.relativePath);
      const alias = localModelUrl(relative);
      const cached = await cache.match(alias);
      if (cached) {
        completed += Number(file.size || 0);
        setDownloadProgress(completed, total, relative);
        continue;
      }
      const remote = `${FILE_BASE}${file.path.split("/").map(encodeURIComponent).join("/")}`;
      await cacheResponseFromUrl(remote, alias, signal, (current) => {
        setDownloadProgress(completed + current, total, relative);
      });
      completed += Number(file.size || 0);
      setDownloadProgress(completed, total, relative);
    }
    const libAlias = localModelUrl("__model_lib__.wasm");
    if (!(await cache.match(libAlias))) {
      await cacheResponseFromUrl(modelLibRemote, libAlias, signal, (current) => {
        setDownloadProgress(completed + current, total, "WebGPU-библиотека");
      });
      completed += modelLibSize;
    }
    // Save the model root folder so WebLLM's /model-files/ URL resolves correctly.
    localStorage.setItem("smollm_model_root", rootPrefix);
    downloadFinished = true;
    labelEl.textContent = "Модель сохранена";
    percentEl.textContent = "100%";
    progressEl.value = 100;
    detailEl.textContent = `${selected.length} файлов · ${formatBytes(total)} · ${persisted ? "хранилище закреплено" : "хранилище браузера"}`;
    setStatus("Модель скачана", "ready");
    loadBtn.disabled = false;
    loadBtn.textContent = "▶ Начать общение";
    downloadBtn.textContent = "✓ Модель скачана";
    addMessage("assistant", "Модель SmolLM2 скачана и сохранена на этом устройстве. Теперь можно отключить интернет и нажать «Начать общение».");
  } catch (e) {
    if (e.name === "AbortError") {
      labelEl.textContent = "Загрузка отменена";
      detailEl.textContent = "Можно начать скачивание заново.";
      setStatus("Загрузка отменена", "");
    } else {
      labelEl.textContent = "Ошибка загрузки";
      detailEl.textContent = e.message;
      setStatus("Ошибка загрузки", "error");
      addMessage("assistant", `Не удалось скачать модель:\n${e.message}`);
    }
  } finally {
    downloadController = null;
    downloadBtn.disabled = false;
    cancelBtn.hidden = true;
  }
}
async function loadModel() {
  if (engine) return;
  loadBtn.disabled = true;
  try {
    if (!navigator.gpu) throw new Error("В этом браузере WebGPU недоступен. Нужен совместимый Android-телефон и актуальный Chrome.");
    if (!await isAlreadyDownloaded()) throw new Error("Сначала скачай модель кнопкой «Скачать SmolLM2».");
    model: localModelUrl(rootPrefix),
model_id: MODEL_ID,
model_lib: localModelUrl("__model_lib__.wasm"),
      appConfig: {
        model_list: [{
          model: "/model-files/",
          model_id: MODEL_ID,
          model_lib: "/model-files/__model_lib__.wasm",
          vram_required_MB: 872,
          low_resource_required: true,
          required_features: ["shader-f16"],
          overrides: { context_window_size: 4096 }
        }]
      },
      initProgressCallback: p => setStatus(p.text || "Подготовка модели…", "working")
    });
    setStatus("Готова к работе", "ready");
    promptEl.disabled = false;
    sendEl.disabled = false;
    promptEl.focus();
    document.querySelector(".welcome")?.remove();
  } catch (e) {
    loadBtn.disabled = false;
    setStatus("Не удалось запустить", "error");
    addMessage("assistant", `Ошибка запуска:\n${e.message}`);
  }
}
downloadBtn.addEventListener("click", downloadModel);
cancelBtn.addEventListener("click", () => downloadController?.abort());
loadBtn.addEventListener("click", loadModel);

document.querySelectorAll(".suggestion").forEach(b => b.addEventListener("click", () => {
  promptEl.value = b.textContent;
  promptEl.focus();
}));
document.querySelector("#chatForm").addEventListener("submit", async e => {
  e.preventDefault();
  const prompt = promptEl.value.trim();
  if (!prompt || !engine || busy) return;
  busy = true;
  promptEl.value = "";
  promptEl.style.height = "auto";
  promptEl.disabled = sendEl.disabled = true;
  addMessage("user", prompt);
  history.push({ role: "user", content: prompt });
  const output = addMessage("assistant");
  setStatus("Думаю…", "working");
  try {
    const stream = await engine.chat.completions.create({
      messages: [{ role: "system", content: "Ты полезный ИИ-ассистент. Отвечай на языке пользователя, ясно и доброжелательно." }, ...history],
      temperature: 0.7,
      max_tokens: 512,
      stream: true
    });
    let answer = "";
    for await (const part of stream) {
      answer += part.choices?.[0]?.delta?.content || "";
      output.textContent = answer;
      messagesEl.scrollTop = messagesEl.scrollHeight;
    }
    history.push({ role: "assistant", content: answer });
    setStatus("Готова к работе", "ready");
  } catch (err) {
    output.textContent = `Ошибка генерации: ${err.message}`;
    setStatus("Ошибка", "error");
  } finally {
    busy = false;
    promptEl.disabled = sendEl.disabled = false;
    promptEl.focus();
  }
});
promptEl.addEventListener("input", () => {
  promptEl.style.height = "auto";
  promptEl.style.height = Math.min(promptEl.scrollHeight, 130) + "px";
});
if ("serviceWorker" in navigator) {
  window.addEventListener("load", async () => {
    try {
      await navigator.serviceWorker.register(`${import.meta.env.BASE_URL}sw.js`);
      await navigator.serviceWorker.ready;
      if (await isAlreadyDownloaded()) {
        downloadFinished = true;
        downloadBtn.textContent = "✓ Модель скачана";
        loadBtn.disabled = false;
      }
    } catch (e) {
      console.warn("Service worker registration failed", e);
    }
  });
}
