#!/bin/sh
# مشترك بين docker-migrate.sh وdocker-entrypoint.sh — يُستدعى بـ`. ` لا
# بتنفيذ مباشر. ازدواج هذا المنطق بين سكربتين كان يعني انحرافاً صامتاً:
# تعديلٌ في أحدهما بلا الآخر يترك المهاجرة تشتق DATABASE_URL_V2 بطريقة
# تخالف ما تتوقعه الحاوية وقت التشغيل الفعلي.

# مرجع متغير لخدمة باسم خاطئ (${{اسم.VAR}}) يُستبدَل بسلسلة فارغة بصمت على
# Railway، فيصل Prisma إلى رابط فارغ ويطبع جدار أخطاء P1012 في حلقة إعادة
# تشغيل. نمسك الحالة هنا برسالة واحدة مفهومة.
#
# **AquaGo: مخطّط واحد.** GasGO كان يحمل مخطّطَين (legacy + v2) فكان
# يشتقّ الثاني من الأول عند النشر. AquaGo بدأ من v2 وحده، فالمتغيّر
# المطلوب هو `DATABASE_URL_V2` مباشرة — ومع ذلك يُقبل `DATABASE_URL`
# مصدرًا له، لأن Railway يسمّي متغيّر قاعدته هكذا افتراضًا وإغفال ذلك
# يعني نشرًا يفشل على متغيّرٍ اسمُه صحيحٌ في لوحة Railway وخاطئ هنا.
require_database_url_v2() {
  if [ -z "$DATABASE_URL_V2" ] && [ -n "$DATABASE_URL" ]; then
    export DATABASE_URL_V2="$DATABASE_URL"
    echo "🔀 DATABASE_URL_V2 مشتقّ من DATABASE_URL"
  fi
  if [ -z "$DATABASE_URL_V2" ]; then
    echo "❌ DATABASE_URL_V2 فارغ أو غير معرَّف — لا يمكن الإقلاع."
    echo "   Railway: مرجع متغيّر لخدمة باسم خاطئ (\${{اسم.VAR}}) يُستبدَل"
    echo "   بسلسلة فارغة بصمت — تأكد أن الاسم يطابق اسم خدمة القاعدة."
    echo "   DigitalOcean: تأكد أن المتغيّر معرَّف على المكوّن (component)"
    echo "   نفسه، لا على مستوى التطبيق وحده."
    exit 1
  fi
}

# انتظار جاهزية القاعدة قبل Prisma. على Railway تحتاج الشبكة الخاصة ثوانيَ
# لتصبح قابلة للحل بعد إقلاع الحاوية، وقد تكون القاعدة نفسها ما زالت تقلع.
# بلا هذا الانتظار تفشل أول محاولة اتصال فوراً بلا فرصة لإعادة المحاولة.
wait_for_database() {
  node -e '
    const net = require("net");
    const u = new URL(process.env.DATABASE_URL_V2);
    const port = Number(u.port || 5432);
    const deadline = Date.now() + 120000;
    let announced = false;
    (function attempt() {
      const s = net.connect({ host: u.hostname, port });
      s.setTimeout(4000);
      s.on("connect", () => {
        s.destroy();
        console.log("✅ القاعدة جاهزة على " + u.hostname + ":" + port);
        process.exit(0);
      });
      const retry = () => {
        s.destroy();
        if (Date.now() > deadline) {
          console.error("❌ تعذّر الوصول إلى " + u.hostname + ":" + port + " خلال 120 ثانية.");
          console.error("   تحقق من أن خدمة قاعدة البيانات تعمل فعلاً (راجع سجلّاتها)،");
          console.error("   وأن اسم المضيف يطابق الشبكة الخاصة للمشروع.");
          process.exit(1);
        }
        if (!announced) {
          console.log("⏳ بانتظار " + u.hostname + ":" + port + " ...");
          announced = true;
        }
        setTimeout(attempt, 3000);
      };
      s.on("error", retry);
      s.on("timeout", retry);
    })();
  '
}
