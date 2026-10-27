# DECISIONS — render-fleet-registry

سجل القرارات المستقلة (القاعدة: أقرر ذاتيًا، وأوثّق هنا).

## Phase 1 — Stability (v3.0.0)

| # | القرار | الدافع |
|---|--------|--------|
| D1 | إعادة كتابة كاملة server.js (v3.0.0) بدلًا من ترقيع v2 | v2 كان بلا scopes ولا audit ولا rate-limit؛ البنية الجديدة تتحمل إضافات Phase 2+ |
| D2 | توكنات API محدودة النطاق (`read/write/config/monitors/admin`)، sha256 عند التخزين | مفتاح واحد لكل شيء لا يتوسع؛ CI/بوت يأخذ `monitors` فقط |
| D3 | Rate-limit لكل IP: 120 دقيقة على `/api/*` (قابل للضبط عبر `RATE_LIMIT_MAX`) | Free tier؛ حماية من استنزاف CPU |
| D4 | سجل تدقيق `audit` (سقف 300) + رؤوس أمان + CSP + منع path-traversal | قابلية تتبع + تحصين أساسي |
| D5 | محرك مراقبة: تاريخ في الذاكرة، تُكتب **الانتقالات فقط** للـ store + نبضة كل 6 ساعات | تقليل commits على GitHub إلى الحد الأدنى |
| D6 | self-heal: افتراضيًا **مفعّل** — failThreshold=2، cooldown 30د، سقف 6/يوم، autoResume **معطل** | الخدمة المعلقة بسبب billing لن تحلها إعادة النشر؛ autoResume خطر لأن billing يوقف مجددًا فورًا |
| D7 | **فصل الـ store عن الكود**: `immmh5/render-fleet-data` (خاص) بدل نفس المستودع | autoDeploy كان يعيد نشر الخدمة مع **كل كتابة store** — حلقة نشر لا نهائية |
| D8 | القائد (الـ registry نفسه) = حساب #1 `nacho-clump-ounce`، `REGISTRY_ACCOUNT_IDX=1` | مستثنى من `/api/suggest`، ولا يُنشر أبدًا على الحسابات الأخرى |
| D9 | `version: 3` يُختم على كل كتابة store | تمييز شكل v3 عن v2 عند القراءة المستقبلية |
| D10 | حساب #4 `acct-d-rhux`: 3 خدمات معلقة (billing) — المراقبة تعلّمها `degraded`، والـ alerts ترفع `critical` | مُلاحَظ ولا يُمس تلقائيًا (autoResume معطل) |
| D11 | **درس تشغيلي حاسم:** `PUT /v1/services/{id}/env-vars` في Render API **يستبدل المجموعة كاملة** — لا يدمج. كل تعديل env يجب أن يرسل **المجموعة الكاملة** (15 متغيرًا حاليًا). محو المتغيرات عرضيًا = مثيل جديد ينهار قبل `/health` → `update_failed` خلال ~24ث | تسبب في فشل نشرين متتاليين (23:49 و 00:00)؛ سبب `update_failed` الفوري لم يكن الكود بل env المنحوس |
| D12 | دورة المراقبة تُقرأ **ديناميكيًا من store config** (`config.monitor.checkIntervalMin`، حاليًا 10د) كل جولة بدل ثابت 5د | تعديل الدورة من الـ API يسري دون إعادة نشر؛ `/api/monitors` وboot log يعرضان القيمة الفعلية |
| D13 | `status` في `/api/fleet` مشتق: `suspended` → `maintenanceStatus` إن وُجد → وإلا `live` | Render API لا يوفر حقل حالة مباشرًا للخدمات الحية؛ v1 كان يعيد `null` |

## روابط الإنتاج

- Registry: https://render-fleet-registry-uyjn.onrender.com (`srv-dbesibom7kps73eurkig` على حساب #1)
- Code repo: `immmh5/render-fleet-registry` (autoDeploy: yes)
- Data repo: `immmh5/render-fleet-data` **(خاص)** — `fleet-data.json@main`
- طوبولوجيا الحسابات: #1 قائد (registry) · #2 فارغ (مُرشّح للنشر) · #3 session-key-proxy · #4 معلق بالكامل

## معلقات Phase 2

- Telegram: الكود جاهز + batching، ينقص `TELEGRAM_BOT_TOKEN`/`TELEGRAM_CHAT_ID` في env
- PWA + لوحة تحكم v3 (توظّف المسارات الجديدة: tokens/audit/monitors/deploys/usage)
