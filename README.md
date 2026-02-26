<div align="center">

# 🧠 memory-lancedb-pro

**Enhanced Long-Term Memory Plugin for [OpenClaw](https://github.com/openclaw/openclaw)**

Hybrid Retrieval (Vector + BM25) · Cross-Encoder Rerank · Multi-Scope Isolation · Management CLI

[![OpenClaw Plugin](https://img.shields.io/badge/OpenClaw-Plugin-blue)](https://github.com/openclaw/openclaw)
[![LanceDB](https://img.shields.io/badge/LanceDB-Vectorstore-orange)](https://lancedb.com)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)

**English** | [简体中文](README_CN.md)

</div>

---

## 📺 Video Tutorial

> **Watch the full walkthrough — covers installation, configuration, and how hybrid retrieval works under the hood.**

[![YouTube Video](https://img.shields.io/badge/YouTube-Watch%20Now-red?style=for-the-badge&logo=youtube)](https://youtu.be/MtukF1C8epQ)
🔗 **https://youtu.be/MtukF1C8epQ**

[![Bilibili Video](https://img.shields.io/badge/Bilibili-立即观看-00A1D6?style=for-the-badge&logo=bilibili&logoColor=white)](https://www.bilibili.com/video/BV1zUf2BGEgn/)
🔗 **https://www.bilibili.com/video/BV1zUf2BGEgn/**

---

## Why This Plugin?

The built-in `memory-lancedb` plugin in OpenClaw provides basic vector search. **memory-lancedb-pro** takes it much further:

| Feature | Built-in `memory-lancedb` | **memory-lancedb-pro** |
|---------|--------------------------|----------------------|
| Vector search | ✅ | ✅ |
| BM25 full-text search | ❌ | ✅ |
| Hybrid fusion (Vector + BM25) | ❌ | ✅ |
| Cross-encoder rerank (Jina / custom endpoint) | ❌ | ✅ |
| Recency boost | ❌ | ✅ |
| Time decay | ❌ | ✅ |
| Length normalization | ❌ | ✅ |
| MMR diversity | ❌ | ✅ |
| Multi-scope isolation | ❌ | ✅ |
| Noise filtering | ❌ | ✅ |
| Adaptive retrieval | ❌ | ✅ |
| Management CLI | ❌ | ✅ |
| Session memory | ❌ | ✅ |
| Task-aware embeddings | ❌ | ✅ |
| Any OpenAI-compatible embedding | Limited | ✅ (OpenAI, Gemini, Jina, Ollama, etc.) |

---

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│                   index.ts (Entry Point)                │
│  Plugin Registration · Config Parsing · Lifecycle Hooks │
└────────┬──────────┬──────────┬──────────┬───────────────┘
         │          │          │          │
    ┌────▼───┐ ┌────▼───┐ ┌───▼────┐ ┌──▼──────────┐
    │ store  │ │embedder│ │retriever│ │   scopes    │
    │ .ts    │ │ .ts    │ │ .ts    │ │    .ts      │
    └────────┘ └────────┘ └────────┘ └─────────────┘
         │                     │
    ┌────▼───┐           ┌─────▼──────────┐
    │migrate │           │noise-filter.ts │
    │ .ts    │           │adaptive-       │
    └────────┘           │retrieval.ts    │
                         └────────────────┘
    ┌─────────────┐   ┌──────────┐
    │  tools.ts   │   │  cli.ts  │
    │ (Agent API) │   │ (CLI)    │
    └─────────────┘   └──────────┘
```

### File Reference

| File | Purpose |
|------|---------|
| `index.ts` | Plugin entry point. Registers with OpenClaw Plugin API, parses config, mounts `before_agent_start` (auto-recall), `agent_end` (auto-capture), and `command:new` (session memory) hooks |
| `openclaw.plugin.json` | Plugin metadata + full JSON Schema config declaration (with `uiHints`) |
| `package.json` | NPM package info. Depends on `@lancedb/lancedb`, `openai`, `@sinclair/typebox` |
| `cli.ts` | CLI commands: `memory list/search/stats/delete/delete-bulk/export/import/reembed/migrate` |
| `src/store.ts` | LanceDB storage layer. Table creation / FTS indexing / Vector search / BM25 search / CRUD / bulk delete / stats |
| `src/embedder.ts` | Embedding abstraction. Compatible with any OpenAI-API provider (OpenAI, Gemini, Jina, Ollama, etc.). Supports task-aware embedding (`taskQuery`/`taskPassage`) |
| `src/retriever.ts` | Hybrid retrieval engine. Vector + BM25 → RRF fusion → Jina Cross-Encoder Rerank → Recency Boost → Importance Weight → Length Norm → Time Decay → Hard Min Score → Noise Filter → MMR Diversity |
| `src/scopes.ts` | Multi-scope access control. Supports `global`, `agent:<id>`, `custom:<name>`, `project:<id>`, `user:<id>` |
| `src/tools.ts` | Agent tool definitions: `memory_recall`, `memory_store`, `memory_forget` (core) + `memory_stats`, `memory_list` (management) |
| `src/noise-filter.ts` | Noise filter. Filters out agent refusals, meta-questions, greetings, and low-quality content |
| `src/adaptive-retrieval.ts` | Adaptive retrieval. Determines whether a query needs memory retrieval (skips greetings, slash commands, simple confirmations, emoji) |
| `src/migrate.ts` | Migration tool. Migrates data from the built-in `memory-lancedb` plugin to Pro |

---

## Core Features

### 1. Hybrid Retrieval

```
Query → embedQuery() ─┐
                       ├─→ RRF Fusion → Rerank → Recency Boost → Importance Weight → Filter
Query → BM25 FTS ─────┘
```

- **Vector Search**: Semantic similarity via LanceDB ANN (cosine distance)
- **BM25 Full-Text Search**: Exact keyword matching via LanceDB FTS index
- **Fusion Strategy**: Vector score as base, BM25 hits get a 15% boost (tuned beyond traditional RRF)
- **Configurable Weights**: `vectorWeight`, `bm25Weight`, `minScore`

### 2. Cross-Encoder Reranking

- **Reranker API**: Jina, SiliconFlow, Pinecone, or any compatible endpoint (5s timeout protection)
- **Hybrid Scoring**: 60% cross-encoder score + 40% original fused score
- **Graceful Degradation**: Falls back to cosine similarity reranking on API failure

### 3. Multi-Stage Scoring Pipeline

| Stage | Formula | Effect |
|-------|---------|--------|
| **Recency Boost** | `exp(-ageDays / halfLife) * weight` | Newer memories score higher (default: 14-day half-life, 0.10 weight) |
| **Importance Weight** | `score *= (0.7 + 0.3 * importance)` | importance=1.0 → ×1.0, importance=0.5 → ×0.85 |
| **Length Normalization** | `score *= 1 / (1 + 0.5 * log2(len/anchor))` | Prevents long entries from dominating (anchor: 500 chars) |
| **Time Decay** | `score *= 0.5 + 0.5 * exp(-ageDays / halfLife)` | Old entries gradually lose weight, floor at 0.5× (60-day half-life) |
| **Hard Min Score** | Discard if `score < threshold` | Removes irrelevant results (default: 0.35) |
| **MMR Diversity** | Cosine similarity > 0.85 → demoted | Prevents near-duplicate results |

### 4. Multi-Scope Isolation

- **Built-in Scopes**: `global`, `agent:<id>`, `custom:<name>`, `project:<id>`, `user:<id>`
- **Agent-Level Access Control**: Configure per-agent scope access via `scopes.agentAccess`
- **Default Behavior**: Each agent accesses `global` + its own `agent:<id>` scope

### 5. Adaptive Retrieval

- Skips queries that don't need memory (greetings, slash commands, simple confirmations, emoji)
- Forces retrieval for memory-related keywords ("remember", "previously", "last time", etc.)
- CJK-aware thresholds (Chinese: 6 chars vs English: 15 chars)

### 6. Noise Filtering

Filters out low-quality content at both auto-capture and tool-store stages:
- Agent refusal responses ("I don't have any information")
- Meta-questions ("do you remember")
- Greetings ("hi", "hello", "HEARTBEAT")

### 7. Session Memory

- Triggered on `/new` command — saves previous session summary to LanceDB
- Disabled by default (OpenClaw already has native `.jsonl` session persistence)
- Configurable message count (default: 15)

### 8. Auto-Capture & Auto-Recall

- **Auto-Capture** (`agent_end` hook): Extracts preference/fact/decision/entity from conversations, deduplicates, stores up to 3 per turn
- **Auto-Recall** (`before_agent_start` hook): Injects `<relevant-memories>` context (up to 3 entries)

---

## Installation

### What is the “OpenClaw workspace”?

In OpenClaw, the **agent workspace** is the agent’s working directory (default: `~/.openclaw/workspace`).
According to the docs, the workspace is the **default cwd**, and **relative paths are resolved against the workspace** (unless you use an absolute path).

> Note: OpenClaw configuration typically lives under `~/.openclaw/openclaw.json` (separate from the workspace).

**Common mistake:** cloning the plugin somewhere else, while keeping `plugins.load.paths: ["plugins/memory-lancedb-pro"]` (a **relative path**). In that case OpenClaw will look for `plugins/memory-lancedb-pro` under your **workspace** and fail to load it.

### Option A (recommended): clone into `plugins/` under your workspace

```bash
# 1) Go to your OpenClaw workspace (default: ~/.openclaw/workspace)
#    (You can override it via agents.defaults.workspace.)
cd /path/to/your/openclaw/workspace

# 2) Clone the plugin into workspace/plugins/
git clone https://github.com/win4r/memory-lancedb-pro.git plugins/memory-lancedb-pro

# 3) Install dependencies
cd plugins/memory-lancedb-pro
npm install
```

Then reference it with a relative path in your OpenClaw config:

```json
{
  "plugins": {
    "load": {
      "paths": ["plugins/memory-lancedb-pro"]
    },
    "entries": {
      "memory-lancedb-pro": {
        "enabled": true,
        "config": {
          "embedding": {
            "apiKey": "${JINA_API_KEY}",
            "model": "jina-embeddings-v5-text-small",
            "baseURL": "https://api.jina.ai/v1",
            "dimensions": 1024,
            "taskQuery": "retrieval.query",
            "taskPassage": "retrieval.passage",
            "normalized": true
          }
        }
      }
    },
    "slots": {
      "memory": "memory-lancedb-pro"
    }
  }
}
```

### Option B: clone anywhere, but use an absolute path

```json
{
  "plugins": {
    "load": {
      "paths": ["/absolute/path/to/memory-lancedb-pro"]
    }
  }
}
```

### Restart

```bash
openclaw gateway restart
```

> **Note:** If you previously used the built-in `memory-lancedb`, disable it when enabling this plugin. Only one memory plugin can be active at a time.

### Verify installation (recommended)

1) Confirm the plugin is discoverable/loaded:

```bash
openclaw plugins list
openclaw plugins info memory-lancedb-pro
```

2) If anything looks wrong, run the built-in diagnostics:

```bash
openclaw plugins doctor
```

3) Confirm the memory slot points to this plugin:

```bash
# Look for: plugins.slots.memory = "memory-lancedb-pro"
openclaw config get plugins.slots.memory
```

---

## Configuration

<details>
<summary><strong>Full Configuration Example (click to expand)</strong></summary>

```json
{
  "embedding": {
    "apiKey": "${JINA_API_KEY}",
    "model": "jina-embeddings-v5-text-small",
    "baseURL": "https://api.jina.ai/v1",
    "dimensions": 1024,
    "taskQuery": "retrieval.query",
    "taskPassage": "retrieval.passage",
    "normalized": true
  },
  "dbPath": "~/.openclaw/memory/lancedb-pro",
  "autoCapture": true,
  "autoRecall": true,
  "retrieval": {
    "mode": "hybrid",
    "vectorWeight": 0.7,
    "bm25Weight": 0.3,
    "minScore": 0.3,
    "rerank": "cross-encoder",
    "rerankApiKey": "jina_xxx",
    "rerankModel": "jina-reranker-v2-base-multilingual",
    "rerankEndpoint": "https://api.jina.ai/v1/rerank",
    "rerankProvider": "jina",
    "candidatePoolSize": 20,
    "recencyHalfLifeDays": 14,
    "recencyWeight": 0.1,
    "filterNoise": true,
    "lengthNormAnchor": 500,
    "hardMinScore": 0.35,
    "timeDecayHalfLifeDays": 60
  },
  "enableManagementTools": false,
  "scopes": {
    "default": "global",
    "definitions": {
      "global": { "description": "Shared knowledge" },
      "agent:discord-bot": { "description": "Discord bot private" }
    },
    "agentAccess": {
      "discord-bot": ["global", "agent:discord-bot"]
    }
  },
  "sessionMemory": {
    "enabled": false,
    "messageCount": 15
  }
}
```

</details>

### Embedding Providers

This plugin works with **any OpenAI-compatible embedding API** and **Volcengine multimodal embedding API**:

| Provider | Model | Base URL | Dimensions |
|----------|-------|----------|------------|
| **Jina** (recommended) | `jina-embeddings-v5-text-small` | `https://api.jina.ai/v1` | 1024 |
| **OpenAI** | `text-embedding-3-small` | `https://api.openai.com/v1` | 1536 |
| **Google Gemini** | `gemini-embedding-001` | `https://generativelanguage.googleapis.com/v1beta/openai/` | 3072 |
| **Ollama** (local) | `nomic-embed-text` | `http://localhost:11434/v1` | 768 |
| **Volcengine** | `Doubao-embedding-vision` | `https://ark.cn-beijing.volces.com/api/v3` | 2048 |

<details>
<summary><strong>Volcengine Multimodal Embedding Example</strong></summary>

Volcengine's `Doubao-embedding-vision` model uses a multimodal API endpoint (`/embeddings/multimodal`). Set `provider` to `volcengine-multimodal` to enable this:

```json
{
  "embedding": {
    "provider": "volcengine-multimodal",
    "apiKey": "your-volcengine-api-key",
    "model": "ep-20260226222351-7xf5g",
    "baseURL": "https://ark.cn-beijing.volces.com/api/v3",
    "dimensions": 2048
  }
}
```

> **Note:** The `model` field should be your Volcengine endpoint ID (e.g., `ep-20260226222351-7xf5g`), not the model name.

</details>

### Rerank Providers

Cross-encoder reranking supports multiple providers via `rerankProvider`:

| Provider | `rerankProvider` | Endpoint | Example Model |
|----------|-----------------|----------|---------------|
| **Jina** (default) | `jina` | `https://api.jina.ai/v1/rerank` | `jina-reranker-v2-base-multilingual` |
| **SiliconFlow** (free tier available) | `siliconflow` | `https://api.siliconflow.com/v1/rerank` | `BAAI/bge-reranker-v2-m3`, `Qwen/Qwen3-Reranker-8B` |
| **Pinecone** | `pinecone` | `https://api.pinecone.io/rerank` | `bge-reranker-v2-m3` |

<details>
<summary><strong>SiliconFlow Example</strong></summary>

```json
{
  "retrieval": {
    "rerank": "cross-encoder",
    "rerankProvider": "siliconflow",
    "rerankEndpoint": "https://api.siliconflow.com/v1/rerank",
    "rerankApiKey": "sk-xxx",
    "rerankModel": "BAAI/bge-reranker-v2-m3"
  }
}
```

</details>

<details>
<summary><strong>Pinecone Example</strong></summary>

```json
{
  "retrieval": {
    "rerank": "cross-encoder",
    "rerankProvider": "pinecone",
    "rerankEndpoint": "https://api.pinecone.io/rerank",
    "rerankApiKey": "pcsk_xxx",
    "rerankModel": "bge-reranker-v2-m3"
  }
}
```

</details>

---

## CLI Commands

```bash
# List memories
openclaw memory-pro list [--scope global] [--category fact] [--limit 20] [--json]

# Search memories
openclaw memory-pro search "query" [--scope global] [--limit 10] [--json]

# View statistics
openclaw memory-pro stats [--scope global] [--json]

# Delete a memory by ID (supports 8+ char prefix)
openclaw memory-pro delete <id>

# Bulk delete with filters
openclaw memory-pro delete-bulk --scope global [--before 2025-01-01] [--dry-run]

# Export / Import
openclaw memory-pro export [--scope global] [--output memories.json]
openclaw memory-pro import memories.json [--scope global] [--dry-run]

# Re-embed all entries with a new model
openclaw memory-pro reembed --source-db /path/to/old-db [--batch-size 32] [--skip-existing]

# Migrate from built-in memory-lancedb
openclaw memory-pro migrate check [--source /path]
openclaw memory-pro migrate run [--source /path] [--dry-run] [--skip-existing]
openclaw memory-pro migrate verify [--source /path]
```

---

## Custom Commands (e.g. `/lesson`)

This plugin provides the core memory tools (`memory_store`, `memory_recall`, `memory_forget`, `memory_update`). You can define custom slash commands in your Agent's system prompt to create convenient shortcuts.

### Example: `/lesson` command

Add this to your `CLAUDE.md`, `AGENTS.md`, or system prompt:

```markdown
## /lesson command
When the user sends `/lesson <content>`:
1. Use memory_store to save as category=fact (the raw knowledge)
2. Use memory_store to save as category=decision (actionable takeaway)
3. Confirm what was saved
```

### Example: `/remember` command

```markdown
## /remember command
When the user sends `/remember <content>`:
1. Use memory_store to save with appropriate category and importance
2. Confirm with the stored memory ID
```

### Built-in Tools Reference

| Tool | Description |
|------|-------------|
| `memory_store` | Store a memory (supports category, importance, scope) |
| `memory_recall` | Search memories (hybrid vector + BM25 retrieval) |
| `memory_forget` | Delete a memory by ID or search query |
| `memory_update` | Update an existing memory in-place |

> **Note**: These tools are registered automatically when the plugin loads. Custom commands like `/lesson` are not built into the plugin — they are defined at the Agent/system-prompt level and simply call these tools.

---

## Database Schema

LanceDB table `memories`:

| Field | Type | Description |
|-------|------|-------------|
| `id` | string (UUID) | Primary key |
| `text` | string | Memory text (FTS indexed) |
| `vector` | float[] | Embedding vector |
| `category` | string | `preference` / `fact` / `decision` / `entity` / `other` |
| `scope` | string | Scope identifier (e.g., `global`, `agent:main`) |
| `importance` | float | Importance score 0–1 |
| `timestamp` | int64 | Creation timestamp (ms) |
| `metadata` | string (JSON) | Extended metadata |

---

## Dependencies

| Package | Purpose |
|---------|---------|
| `@lancedb/lancedb` ≥0.26.2 | Vector database (ANN + FTS) |
| `openai` ≥6.21.0 | OpenAI-compatible Embedding API client |
| `@sinclair/typebox` 0.34.48 | JSON Schema type definitions (tool parameters) |

---

## License

MIT

---

## Buy Me a Coffee

[!["Buy Me A Coffee"](https://storage.ko-fi.com/cdn/kofi2.png?v=3)](https://ko-fi.com/aila)

## My WeChat Group and My WeChat QR Code

<img src="https://github.com/win4r/AISuperDomain/assets/42172631/d6dcfd1a-60fa-4b6f-9d5e-1482150a7d95" width="186" height="300">
<img src="https://github.com/win4r/AISuperDomain/assets/42172631/7568cf78-c8ba-4182-aa96-d524d903f2bc" width="214.8" height="291">
<img src="https://github.com/win4r/AISuperDomain/assets/42172631/fefe535c-8153-4046-bfb4-e65eacbf7a33" width="207" height="281">
