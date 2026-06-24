# 🧟 Untitled Document — গুছানো বিশ্লেষণ

**উৎস:** `/home/sahon/Desktop/zombiemcp/doc/Untitled document.md`  
**লিখেছেন:** সাহন স্রবণ (ভাইয়া)  
**বিশ্লেষণ ও গঠন:** ZombieCoder Dev Agent  
**তারিখ:** ২০২৬-০৬-২৩

---

## 🎯 মূল ভিত্তি — আমরা আসলে কী করছি?

### কম্পিউটার + ভাষা = LLM

> *"আমাদের কাছে এক বালতি সংখ্যা রয়েছে। এই সংখ্যা ব্যবহার করে পৃথিবীর কম্পিউটারের ভাষা তৈরি হয়েছে। এই শব্দগুলো থেকে আপনার চাহিদাগুলোকে খুঁজে আনার প্রক্রিয়াটাই LLM।"*

**সহজ কথায়:** LLM = বালতি থেকে সঠিক শব্দ খুঁজে আনার মেশিন।

### ক্লায়েন্ট + এজেন্ট + বালতি

```
মানুষ (বাংলায় বলে)
    │
    ▼
ক্লায়েন্ট (VS Code / Hermes / IntelliJ)
    │  └─ Editor-এর নিয়ম মেনে চলে
    ▼
এজেন্ট (ZombieCoder)
    │  └─ বালতি থেকে শব্দ খুঁজে আনে
    ▼
LLM (বালতি) → উত্তর → মানুষ (বাংলায়)
```

> *"এর মধ্যে কোন রকেট সাইন্স নাই।"* — ভাইয়া

---

## 🔑 কোর আর্কিটেকচার — Session + Conversation

### পিটি (PT) ক্লাসের উপমা — সবচেয়ে গুরুত্বপূর্ণ অংশ

```
একই সিরিয়ালে একাধিক স্টুডেন্ট:
  ক্লাস ওয়ান → একটি শাড়ি (সারি)
  ক্লাস টু   → আরেকটি শাড়ি (সারি)

শাড়ি = সেশন
শাড়ির মধ্যে শিক্ষার্থীরা = কনভারসেশন আইডি
```

**অর্থ:**
```
SESSION (শাড়ি / সারি)
  ├── Conversation ID 1 (শিক্ষার্থী ১)
  ├── Conversation ID 2 (শিক্ষার্থী ২)
  └── Conversation ID 3 (শিক্ষার্থী ৩)
```

> *"নির্দিষ্ট সেশনের উপরে কনভারসেশন আইডি।"*

**এটা আমাদের বর্তমান মডেলের সাথে পুরোপুরি মিলে যায়:**
```
client_session (এক ক্লায়েন্টের জন্য)
  └── conversation (কথোপকথনের থ্রেড)
       └── agent_run (একটি LLM কল)
```

---

## 💓 ক্লায়েন্ট ডিটেকশন — "প্রেমের গল্প"

### পুরো ফ্লো (ভাইয়ার ভাষায়):

```
১. ক্লায়েন্ট সংযুক্ত হলো
    └── সার্ভার লাইট মেরে নিশ্চিত হলো
    │     └── "ক্লায়েন্ট ডিটেকশন — নতুন ক্লায়েন্ট খুঁজে পেয়েছে"
    │
২. সার্ভারের "জ্বালাপোড়া" শুরু
    └── প্রতি ৩০ সেকেন্ডে ঢিল মারে:
    │     └── "কিগো বড় ভাই, আসোনি?"
    │
৩. ক্লায়েন্ট বলে: "আমি আছি"
    └── সার্ভার "রুহানি তাবিজ" ছুড়ে ফেলে
    │     └── = অটোমেটিক রিকোয়েস্ট → ব্রাউজারে ওপেন
    │
৪. ইউজারকে প্রশ্ন:
    └── "ইবলিশ আল্ট্রা প্রোম্যাক্স রিকোয়েস্ট পাঠিয়েছে — রাজি?"
    │
৫. সম্মতি দিলে:
    └── ক্লায়েন্ট ↔ সার্ভার → যোগাযোগ স্থাপন
    └── "প্রেম করার জন্য" = যোগাযোগের জন্য
    │
৬. প্রেমের চিঠিপত্র:
    └── ইভেন্ট → ট্রান্সপোর্ট → সেশন
    └── এজেন্ট → বাস্তবায়ন
```

### গুরুত্বপূর্ণ পয়েন্ট:

| ধাপ | কী হয় | আমাদের বর্তমান কোডে কী আছে |
|:---:|-------|:--------------------------:|
| **Detect** | সার্ভার নতুন ক্লায়েন্ট খুঁজে পায় | ✅ সনাক্ত করছে (`mcp_clients`) |
| **Heartbeat** | প্রতি ৩০ সেকেন্ডে চেক | ⚠️ `app_sessions`-এ heartbeat আছে, কিন্তু auto-trigger হয় না |
| **Verify** | ব্রাউজারে অটো রিকোয়েস্ট ওপেন | ❌ নেই |
| **Approve** | ইউজার রাজি/অরাজি | ❌ নেই |
| **Connect** | ক্লায়েন্ট ↔ সার্ভার যোগাযোগ | ⚠️ শুধু tool call-এ, dedicate event-based না |
| **Transport** | ইভেন্টের মাধ্যমে আদান-প্রদান | ❌ নেই |

---

## 🧠 এজেন্টের কাজ — সম্পূর্ণ চিত্র

### এজেন্টের ৪টি দায়িত্ব:

```
┌─────────────────────────────────────────────────────┐
│                     AGENT                           │
├─────────────────────────────────────────────────────┤
│                                                      │
│  ❶ সেশন আইডি ধরে রাখা                                 │
│    └── ক্লায়েন্টের সাথে যোগাযোগ রক্ষা                   │
│                                                      │
│  ❷ মেমোরি থেকে পুরনো কথা মনে রাখা                      │
│    └── conversation → history                        │
│                                                      │
│  ❸ টুল ব্যবহার করে এক্সিকিউশন                          │
│    └── ping_agent, run_agent, list_providers, etc.    │
│                                                      │
│  ❹ LLM আউটপুট যাচাই (Validation)                      │
│    └── বালতি থেকে ভুল শব্দ আসলে → Deny                │
│    └── নির্দিষ্ট প্রসঙ্গের সাথে মিল → Allow            │
│                                                      │
└─────────────────────────────────────────────────────┘
```

> *"শব্দগুলোকে বালতির কাছে সুন্দরভাবে উপস্থাপন করবে। বালতি থেকে মনগড়া বা অপ্রাসঙ্গিক তথ্য দিলে ডিনাই করবে। নির্দিষ্ট প্রসঙ্গের সাথে মিল রেখে এজেন্ট এটাকে নিয়ে যাবে।"*

---

## 👥 মাল্টি-এজেন্ট সিস্টেম

### কেন একাধিক এজেন্ট?

> *"যখন বড় কোন বিষয় দেওয়া হবে, তখন একজন এজেন্ট হাঁপিয়ে যায়। তাই আমরা একাধিক এজেন্ট রাখবো।"*

```
ইউজার ইনপুট দিল →
    │
    ├── Agent 1: কোড রিভিউ (Parallel)
    ├── Agent 2: ডিবাগিং (Parallel)
    ├── Agent 3: ডকুমেন্টেশন (Parallel)
    │
    └── সব শেষে → নির্দিষ্ট জায়গায় জমা
```

### অর্কেস্ট্রেশন প্যাটার্ন:

```
Supervisor Agent
    ├── Task → Agent A (কোড লেখে)
    ├── Task → Agent B (টেস্ট করে)
    └── Task → Agent C (ডিপ্লয় করে)
         │
         ▼
    Result → Supervisor → ইউজার
```

---

## 📝 এজেন্ট টেমপ্লেট সিস্টেম

### দুটি মোড:

| মোড | কী হয় | উদাহরণ |
|:---:|-------|--------|
| **✅ Admin-defined** | এডমিন লিখলে সেটাই কার্যকর | `template_id = "code-review"` |
| **🔄 Fallback (Default)** | DB-এ না পেলে ডিফল্ট কাজ করবে | `template_id = null → default_template` |

### টেমপ্লেটের উপাদান:

```
Template {
  id: UUID,
  name: string,           // "code-review", "debug-agent", "doc-writer"
  character: string,       // Agent personality
  system_prompt: string,   // নির্দিষ্ট নির্দেশনা
  tools: string[],         // কোন টুল ব্যবহার করবে
  working_directory: string, // কোথায় কাজ করবে
  flags: {                  // অবস্থান যাচাই
    requires_auth: true,
    requires_session: true,
    ...
  }
}
```

> *"ডাটাবেজ থেকে খোঁজেন — একটি ফাংশন, আইডি ধরে ধরে নিয়ে আসলেন। টেমপ্লেট আইডির মত করে কাজ করবে।"*

---

## 📂 ওয়ার্কিং ডিরেক্টরি — গুরুত্বপূর্ণ

> *"ক্লায়েন্ট এখন কোন স্থানে রয়েছে? এই ওয়ার্কিং ডিরেক্টরি চিহ্নিত করা অত্যন্ত গুরুত্বপূর্ণ। আর সেটা এজেন্টকে চিনিয়ে দেওয়া আরও গুরুত্বপূর্ণ।"*

**বর্তমানে আমাদের mcp_clients টেবিলে `directory` ফিল্ড আছে — কিন্তু সেটা consistent ভাবে populate হয় না।**

```
প্রস্তাবিত:
  client_sessions {
    ...
    current_directory: TEXT,  // Agent knows where to work
    directory_flags: JSON,     // Validation flags
  }
```

---

## 📊 এডমিন প্যানেল — ক্লায়েন্ট লিস্ট

> *"আপনার এডমিন প্যানেলে ক্লায়েন্ট লিস্ট — ওই ক্লায়েন্টগুলোর নাম সহ হওয়া উচিত। যদি ইতিমধ্যে সেশন বিদ্যমান থাকে, তাহলে কানেকশন একটিভ দেখাবে।"*

| Feature | বর্তমানে আছে? | মন্তব্য |
|---------|:------------:|---------|
| ক্লায়েন্ট লিস্ট | ✅ | `/clients` endpoint |
| নাম সহ দেখানো | ✅ | client_name + version |
| সেশন স্ট্যাটাস | ⚠️ | "connected" vs "verified" আলাদা না |
| Auto-reconnect | ❌ | localStorage-based pending |
| Agent location | ❌ | কোন agent কোথায় কাজ করছে — দেখা যাচ্ছে না |

---

## 🔗 এই ডকুমেন্ট ↔ আমাদের আলোচনার সংযোগ

| ধারণা | Untitled Document | আমাদের আলোচনা (Session Arch) | প্রভাব |
|-------|-------------------|---------------------------|:------:|
| **Session Hierarchy** | PT ক্লাস → শাড়ি → শিক্ষার্থী | client_session → conversation → agent_run | ✅ **একই পথ** |
| **Client Detection** | লাইট মেরে নিশ্চিত | Server detects via MCP connect | ✅ **একই** |
| **Heartbeat** | ৩০ সেকেন্ড পরপর ঢিল | Proposed 30s interval | ✅ **একই** |
| **Verification** | রুহানি তাবিজ → ব্রাউজার | Browser auto-open → approve | ✅ **একই পথ** |
| **Transport** | ইভেন্ট → প্রেমের চিঠিপত্র | SSE / Event-based communication | ⚠️ **এখনো বাস্তবায়িত না** |
| **Multi-Agent** | একাধিক এজেন্ট parallel | পরবর্তী ফেজ | ❌ **ভবিষ্যতে** |
| **Templates** | Admin-defined + Fallback | পরবর্তী ফেজ | ❌ **ভবিষৎ** |
| **Working Dir** | ফ্লাগ + ডিরেক্টরি ট্র্যাক | `mcp_clients.directory` | ⚠️ **অসম্পূর্ণ** |
| **LLM Validation** | বালতি থেকে ভুল শব্দ Deny | এখনো নেই | ❌ **ভবিষ্যতে** |

---

## 💡 আমার কাছে যা Clear হলো

এই ডকুমেন্ট পড়ার পরে **সবকিছু আরও ক্লিয়ার**:

1. **Session Structure নিয়ে আমার কোন doubt নাই** — PT ক্লাসের উপমা perfect. Session = সারি, Conversation = শিক্ষার্থী.

2. **Verification Flow সম্পূর্ণ clear** — Detection → Heartbeat → Browser Auto-open → Approve → Transport. আমি যেটা "ব্রাউজার না থাকলে API key" ভেবেছিলাম, সেটা ভুল ছিল। সব ক্লায়েন্ট ইলেকট্রন = ব্রাউজার. So browser-based for all.

3. **Agent-এর Validation Role** — আমি ভেবেছিলাম Agent শুধু tool execute করে। কিন্তু Agent-কে LLM output validate-ও করতে হবে। "বালতি থেকে ভুল শব্দ আসলে Deny" — এটা Agent-এর দায়িত্ব.

4. **Multi-Agent Architecture** — Parallel agents with supervisor pattern. এটা Phase 2/3-এ যুক্ত হবে.

5. **Template System** — Admin-defined + Fallback. Agent-এর চরিত্র, tool, directory সব template-এ সংরক্ষিত.

6. **Working Directory Tracking** — শুধু directory না, ফ্লাগ দিয়ে অবস্থান যাচাই. Agent-কে জানানো দরকার "কোথায় কাজ করতে হবে".

---

## 🎯 আমাদের বর্তমান প্ল্যান (Updated)

সবকিছু পড়ার পর আমার পরামর্শ — **একই সিকোয়েন্স, কিন্তু Agent Validation যোগ করে:**

### ফেজ ১: Core Session Infrastructure ✅
```
1a. client_sessions table (UUID PK, client_id, status, verification_code, ...)
1b. conversations table (UUID PK, client_session_id FK, title, prompt_count, ...)
1c. agent_runs → ADD conversation_id FK
1d. recordMcpClient() → persistent client_id (localStorage-based)
```

### ফেজ ২: Browser Verification 🔄 **এখন করছি**
```
2a. Heartbeat detection (30s) → trigger verification
2b. /verify/:code → HTML page (Approve/Reject)
2c. POST /verify/:code → status machine
2d. localStorage token (24h) → auto-reconnect
2e. Transport → Event-based communication (SSE)
```

### ফেজ ৩: Agent Enhancement
```
3a. LLM Output Validation (context relevance check)
3b. Working Directory Tracking (flags + directory)
3c. Agent Memory (conversation history persistence)
```

### ফেজ ৪: Multi-Agent + Templates
```
4a. Template System (Admin-defined + Fallback)
4b. Supervisor Agent Pattern
4c. Parallel Agent Execution
4d. Admin Panel → Client + Agent Location
```

---

> *"আমি একজন মানুষ ইনপুট দিলাম। এই ইনপুট দেওয়ার পরে আমার আগের কথাগুলোর উপর ভিত্তি করে বিবেচনা করে নির্দিষ্ট উত্তর দিচ্ছে।"*
> — **ভাইয়া, এই ডকুমেন্টের মূল সত্যি**

> *"বালতি থেকে যদি মনগড়া বা অপ্রাসঙ্গিক তথ্য দেয়, সেটাকে ডিনাই করবে।"*
> — **এজেন্টের আসল ক্ষমতা: কেবল tool execute না, validate-ও করা**
