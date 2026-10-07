# Render Fleet Registry — الموقع الوسيط

موقع وسيط (orchestrator) يدير **عدة حسابات Render** في مكان واحد.
يعطي الذكاء الاصطناعي API واحد للنشر على أي حساب، ولوحة تحكم تعرض كل المشاريع.

## 💡 لماذا stateless + GitHub؟

Free web services على Render عندها **filesystem مؤقت** — أي قاعدة بيانات محلية
تضيع مع كل redeploy. الحل: **عدم تخزين أي حالة**.

كل البيانات التي نحتاجها موجودة أصلاً في Render API:
- متى انشئ المشروع ← `service.createdAt`
- الدومينات ← `GET /services/:id/custom-domains`
- الحساب ← المصدر الذي جئنا منه
- الحالة ← `service.status` + `service.suspended`

المفاتيح تأتي من **environment variables** (تبقى ثابتة عبر deploys).

بما أنّ كل حساب مسؤول عن نشر نفسه، فأي **بيانات وصفية** إضافية (اسم المشروع، الفئة،
الملاحظة، وسجلّ النشر `deploys`) تحفظ في ملف JSON على **GitHub** عبر
`FLEET_GH_*` — فتبقى محفوظة عبر redeploys، بدون أي قاعدة بيانات.

## 🔧 Environment Variables

| المتغير | مثال | الوصف |
|---|---|---|
| `REGISTRY_API_KEY` | `fleet-secret-xyz` | مفتاح الـ API (يستخدمه الذكاء الاصطناعي ولوحة التحكم) |
| `RENDER_ACCOUNT_1_NAME` | `محمد الرئيسي` | اسم الحساب الظاهر في اللوحة |
| `RENDER_ACCOUNT_1_KEY` | `rdr_xxx...` | Render API key للحساب الأول |
| `RENDER_ACCOUNT_2_NAME` | `الحساب التجاري` | الحساب الثاني |
| `RENDER_ACCOUNT_2_KEY` | `rdr_yyy...` | Render API key للحساب الثاني |
| `REGISTRY_ACCOUNT_IDX` | `1` | فهرس "قائد الأسطول" — الحساب الذي يستضيف الـ Registry نفسه؛ يُستثنى من التوزيع التلقائي |
| `FLEET_GH_TOKEN` | `ghp_xxx...` | GitHub token (صلاحية `repo`) لحفظ البيانات الوصفية وسجلّ النشر |
| `FLEET_GH_REPO` | `immmh5/render-fleet-registry` | المستودع الذي تُحفظ فيه البيانات (اختياري) |
| `FLEET_GH_BRANCH` | `main` | الفرع (اختياري) |
| `FLEET_GH_FILE` | `fleet-data.json` | اسم ملف البيانات (اختياري) |

أضف `RENDER_ACCOUNT_3_*`، `4_*`... بدون حد.
بدون `FLEET_GH_TOKEN` تعمل الخدمة لكن البيانات الوصفية تبقى في الذاكرة فقط وتضيع مع إعادة النشر.

## 🚀 النشر

```bash
# انشر هذا المستودع كـ Web Service على حساب Render منفصل
# Build Command:    npm install
# Start Command:    node server.js
```

أو استخدم `render.yaml` Blueprint.

## 📡 API

كل الطلبات تحتاج:
```
Authorization: Bearer $REGISTRY_API_KEY
```

| Method | Path | الوصف |
|---|---|---|
| `GET` | `/health` | فحص صحة الخدمة (يستخدمه Render) |
| `GET` | `/api/fleet` | كل الحسابات + كل المشاريع + الدومينات + التواريخ + سجلّ النشر |
| `GET` | `/api/accounts` | سعة كل حساب (دومينات مستخدمة / حد) |
| `GET` | `/api/config` | الإعدادات والحدود والاستراتيجيات الحالية |
| `PUT` | `/api/config` | تحديث الإعدادات والحدود (مثال: `{limits:{maxServicesPerAccount:3}}`) |
| `GET` | `/api/alerts` | إنذارات (تعليق/حدود/حالة) |
| `POST` | `/api/suggest` | يرشح أفضل حساب لمشروع جديد |
| `POST` | `/api/services` | ينشئ خدمة (يختار الحساب تلقائياً أو `account=N`) ويسجّل النشر |
| `GET` | `/api/services/:acct/:id` | تفاصيل الخدمة |
| `GET` | `/api/services/:acct/:id/custom-domains` | دومينات الخدمة |
| `POST` | `/api/services/:acct/:id/custom-domains` | يضيف دومين `{domain:"example.com"}` |
| `DELETE` | `/api/services/:acct/:id/custom-domains/:domain` | يحذف دومين |
| `POST` | `/api/services/:acct/:id/deploys` | ينشر يدوياً (اختيارياً `{clearCache:true}`) ويسجّل في سجلّ النشر |
| `GET` | `/api/services/:acct/:id/envs` | env vars الحالية للخدمة |
| `PUT` | `/api/services/:acct/:id/envs` | يحدّث env vars |
| `PUT`/`PATCH` | `/api/services/:acct/:id/metadata` | يحدّث البيانات الوصفية (الاسم، الفئة، الملاحظة...) |
| `POST` | `/api/services/:acct/:id/suspend` | يعلّق الخدمة |
| `POST` | `/api/services/:acct/:id/resume` | يفك تعليق الخدمة |
| `DELETE` | `/api/services/:acct/:id` | يحذف الخدمة |

`acct` = رقم الحساب (1، 2، 3...).

### سجلّ النشر (deploys)

كل إنشاء أو نشر يدوي يضيف حدثاً إلى `store.projects[sid].deploys` المحفوظ في
GitHub:
```json
{ "at": "2025-10-06T18:00:00.000Z", "trigger": "create|manual", "kind": "created|deploy", "status": "pending", "deployId": "..." }
```
يعرضه `/api/fleet` على أنه `project.deploys` + `project.lastDeploy`، وتظهره لوحة
التحكم في بطاقة كل مشروع.

## 🌐 لوحة التحكم

افتح `/` وأدخل مفتاح `REGISTRY_API_KEY`.
