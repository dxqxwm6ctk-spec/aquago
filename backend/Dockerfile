# بناء على مرحلتين — الأدوات تبقى في مرحلة البناء ولا تُشحَن.
#
# **القياس الذي دعا إلى هذا:** الصورة أحادية المرحلة كانت **1.4GB**،
# تبتلعها طبقتان:
#   • `npm install` بـdevDependencies كاملة (TypeScript، Nest CLI، ts-node) = 523MB
#   • `RUN chown -R node:node /app` = 420MB — لأن تغيير الملكية **يعيد
#     كتابة كل ملف**، فينشئ طبقةً تضاعف الشجرة كلها بدل أن تعدّل مكانها.
# النتيجة بعد المرحلتين و`--chown` على COPY: **573MB** (−59%).
#
# الحجم ليس ترفاً هنا: كل نشر يدفع الصورة ويسحبها، والرجوع لإصدار سابق
# سحبٌ آخر — وهو ما يُقاس بالدقائق وقت العطل تحديداً.

# ---------- مرحلة البناء ----------
FROM node:20-alpine AS build

# Prisma يحتاج OpenSSL على صور Alpine
RUN apk add --no-cache openssl

WORKDIR /app

# prisma قبل npm install لأن postinstall يولّد عميلي المخططين (القديم + v2)
COPY package.json package-lock.json* ./
COPY prisma ./prisma
RUN npm install

COPY tsconfig.json nest-cli.json ./
COPY src ./src
RUN npm run build

# ============================================================================
# **التقليم يحذف عميل Prisma v2 المولَّد.**
#
# السبب الجذري: مخطط v2 يولّد إلى مسار `output` مخصّص داخل
# `node_modules/@prisma-v2/client` (ليجده الكود المُجمَّع في dist/ بمُعرِّف
# عارٍ `@prisma-v2/client` — 54 ملفاً تستورده هكذا). لكن ذلك الدليل ليس
# حزمةً مثبَّتة: لا يذكره package.json ولا package-lock.json، فيراه
# `npm prune` دليلاً زائداً في node_modules **ويحذفه**.
#
# مقيسٌ لا مستنتَج: `ls -d node_modules/@prisma-v2` بعد التقليم يعطي
# "GONE"، ثم `require("@prisma-v2/client")` يرمي
# `Cannot find module '@prisma-v2/client'` — بينما الصورة تُقلع سليمة
# وتجتاز فحص الصحّة. عطلُ وقتِ تشغيل يعبر كل فحص بناء، ولا يظهر إلا عند
# أول طلب على مسار v2 — أي عند أول زبون حقيقي.
#
# **العلاج: التوليد بعد التقليم لا قبله.** التوليد يعيد كتابة المسار
# بنفسه، فلا يعتمد على نسخٍ يدوي — و`cp -R` هنا فخّ مثبَت: نسخُ دليل فوق
# دليل موجود يُعشّشه (`@prisma-v2/@prisma-v2/client`) فيفشل الاستيراد
# بصمت. Prisma يكتب وجهته الصحيحة دائماً.
#
# **ولماذا الثنائية المحلية لا `npx`:** `prisma` تبعيةُ تطوير، فالتقليم
# يزيلها من حيث المبدأ — و`npx prisma` عندها **يُنزّلها من الشبكة** أثناء
# البناء: بناءٌ غير محدَّد المخرجات يعتمد على الإنترنت ويجلب إصداراً قد
# يخالف package-lock. الثنائية تبقى فعلياً بعد التقليم (npm يُبقيها لأنها
# peer اختياري لـ@prisma/client) وهي المطابقة للقفل. `--network=none`
# أعلاه في الاختبار أثبت أن التوليد يتمّ بلا شبكة إطلاقاً.
# ============================================================================
#
# **AquaGo: عميل واحد لا اثنان.** GasGO كان يولّد عميلَين لمخطّطَين
# متوازيَين (legacy + v2). AquaGo بدأ من v2 وحده وحُذف مخطّط legacy،
# فتوليدُ عميلٍ ثانٍ هنا كان سيفشل على مخطّطٍ غير موجود.
RUN npm prune --omit=dev \
  && ./node_modules/.bin/prisma generate --schema prisma/v2/schema.prisma

# بوّابة صريحة: لا تُبنى صورة بلا عميل Prisma. لولاها لعاد العطل نفسه
# صامتاً عند أي تغيير في سلوك npm أو ترتيب الخطوات — وهو عطل لا يظهر إلا
# في الإنتاج. الفشل هنا يكلّف دقيقة بناء؛ الفشل هناك يكلّف انقطاع خدمة.
RUN node -e "require('@prisma-v2/client');" \
  || (echo 'FATAL: عميل Prisma مفقود بعد التقليم — انظر التعليق أعلاه' && exit 1)

# ---------- الصورة النهائية ----------
FROM node:20-alpine

# openssl لـPrisma؛ curl لفحص HEALTHCHECK بلا إضافة عميل HTTP للتطبيق
RUN apk add --no-cache openssl curl

WORKDIR /app

# `--chown` على COPY: الملكية تُكتب أثناء النسخ نفسه، فلا طبقة `chown`
# ثانية تضاعف الشجرة. المستخدم `node` (UID 1000) جاهز في صورة node
# الرسمية فلا حاجة لإنشائه.
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --from=build --chown=node:node /app/package.json ./
COPY --chown=node:node prisma ./prisma
COPY --chown=node:node public ./public
COPY --chown=node:node docker-common.sh docker-migrate.sh docker-entrypoint.sh ./

# البوّابة الثانية — على الصورة **النهائية** لا على مرحلة البناء.
# المرحلة السابقة تُثبت أن العميلين وُلِّدا؛ هذه تُثبت أنهما **وصلا** إلى
# ما يُشحن فعلاً. الخطوتان تحرسان شيئين مختلفين: تلك التوليد، وهذه
# اكتمال النسخ بين المرحلتين (استبعادُ مسارٍ سهواً في COPY لا تكشفه
# الأولى). هذه هي التي تجعل وجود العميلين **مضموناً** لا مرجَّحاً.
RUN node -e "require('@prisma-v2/client');" \
  && echo 'عميل Prisma حاضر في الصورة النهائية'

USER node

EXPOSE 3000

# فحص جاهزية الحاوية نفسها (المرحلة 2.3) — يتفرّع بحسب ROLE لأن العامل لا
# يملك خادم HTTP إطلاقاً (قرار المرحلة 1.1 المتعمَّد: createApplicationContext
# بلا منفذ). curl على /api/health/live لـROLE=api، وhealth-cli.ts (يستدعي
# HealthService نفسها التي يستدعيها مسار API — لا فحص مكرَّر بمنطق مختلف)
# لـROLE=worker. sh -c لازمة: exec form العادية لا تُوسّع $ROLE.
HEALTHCHECK --interval=10s --timeout=5s --start-period=30s --retries=3 \
  CMD sh -c '\
    if [ "$ROLE" = "worker" ]; then \
      node dist/src/v2/health/health-cli.js; \
    else \
      curl -sf http://127.0.0.1:${PORT:-3000}/api/health/live; \
    fi'

# سكربت الإقلاع: يشتق روابط القاعدة (Railway يعطي واحدة)، ينتظر جاهزيتها،
# ثم يشغّل العملية بالدور المطلوب (ROLE=api|worker داخل main.ts). الهجرات
# والبذور صارت خطوة نشر منفصلة (docker-migrate.sh) لا جزءاً من كل إقلاع.
CMD ["sh", "docker-entrypoint.sh"]
