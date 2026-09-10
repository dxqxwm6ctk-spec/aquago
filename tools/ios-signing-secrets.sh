#!/usr/bin/env bash
# ==========================================================================
# AquaGo — فحص ملفات التوقيع وتوليد قيم أسرار GitHub
#
# يفحص أولًا ثم يطبع. سرٌّ مولَّد من ملف غلط لا ينفع بشيء، والعطل الناتج
# يظهر بعد عشر دقائق بناء على رانر مدفوع برسالة لا تدلّ على مصدره — فكل
# فحص هنا مكتوب من عطل وقع فعلًا.
#
# التشغيل (على macOS أو Linux فيه openssl):
#   bash tools/ios-signing-secrets.sh
#
# الملفات المرتبطة:
#   ios_signing/README.md              (شرح كل ملف والخطوات عند آبل)
#   .github/workflows/ios-release.yml  (يستهلك هذه الأسرار)
#   .github/workflows/ios-build.yml    (مسار sideload — لا يحتاج أي سرّ)
# ==========================================================================

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
SIGN_DIR="$ROOT/ios_signing"
OUT_DIR="$SIGN_DIR/base64"

# معرّفا الحزمة كما في project.pbxproj لكل تطبيق.
BUNDLE_CUSTOMER="jo.aquago.customer"
BUNDLE_DRIVER="jo.aquago.driver"

FAILED=0
declare -a SECRET_ROWS=()

red()  { printf '\033[31m%s\033[0m\n' "$*"; }
grn()  { printf '\033[32m%s\033[0m\n' "$*"; }
ylw()  { printf '\033[33m%s\033[0m\n' "$*"; }
hdr()  { printf '\n\033[1m== %s ==\033[0m\n' "$*"; }
fail() { red "  ✗ $*"; FAILED=1; }
ok()   { grn "  ✓ $*"; }

# openssl 3 لا يحمّل RC2 افتراضيًا، وملفات p12 المصدَّرة من سلسلة مفاتيح
# macOS مشفَّرة بـRC2-40 — فتفشل القراءة على ملف سليم تمامًا. لذلك كل قراءة
# للـp12 تمرّ من هنا: المحاولة العادية ثم -legacy قبل الحكم على الملف.
p12_read() {
  local file="$1" pass="$2"; shift 2
  openssl pkcs12 -in "$file" -passin pass:"$pass" "$@" 2>/dev/null && return 0
  openssl pkcs12 -in "$file" -passin pass:"$pass" -legacy "$@" 2>/dev/null && return 0
  return 1
}

find_one() { find "$SIGN_DIR" -maxdepth 2 -type f -name "$1" 2>/dev/null | head -1; }

hdr "المجلد"
if [ ! -d "$SIGN_DIR" ]; then
  red "مجلد ios_signing/ غير موجود — راجع ios_signing/README.md"
  exit 1
fi
ok "$SIGN_DIR"

# ==========================================================================
# ١) الشهادة والمفتاح الخاص
# ==========================================================================
hdr "الشهادة والمفتاح الخاص"

P12="$(find_one '*.p12')"
PASS_FILE="$(find_one 'p12_password.txt')"
CERT_FILE="$(find_one '*.cer')"; [ -n "$CERT_FILE" ] || CERT_FILE="$(find_one '*.pem')"
KEY_FILE="$(find_one '*.key')"
TEAM_ID=""

if [ -z "$P12" ]; then
  fail "لا ملف .p12 في ios_signing/ — صدّره من سلسلة المفاتيح (README خطوة ٤)."
elif [ -z "$PASS_FILE" ]; then
  fail "p12_password.txt غير موجود — بدونه لا يمكن فحص الـp12 ولا استيراده على الرانر."
else
  ok "الـp12: $(basename "$P12")"
  P12_PASS="$(tr -d '\r\n' < "$PASS_FILE")"

  if ! p12_read "$P12" "$P12_PASS" -noout; then
    fail "تعذّرت قراءة الـp12 (جُرِّبت -legacy أيضًا) — كلمة المرور خاطئة أو الملف تالف."
  else
    ok "الـp12 مقروء وكلمة المرور صحيحة."

    # ---- صيغة الـp12: لازم MAC ب sha1 ----
    # security على macOS لا يقبل p12 موقَّعًا بـMAC حديث (sha256): يفشل
    # الاستيراد بـ"MAC verification failed" على ملف كلمة مروره صحيحة تمامًا،
    # وهذا يوقف البناء عند خطوة الاستيراد لا عند إنشاء الملف.
    MACALG="$(openssl pkcs12 -in "$P12" -passin pass:"$P12_PASS" -info -noout 2>&1 \
              || openssl pkcs12 -in "$P12" -passin pass:"$P12_PASS" -info -noout -legacy 2>&1)"
    if printf '%s' "$MACALG" | grep -qi 'MAC:.*sha1'; then
      ok "صيغة MAC: sha1 — يقبلها security على macOS."
    else
      fail "صيغة الـp12 لا يقبلها security على macOS (المطلوب MAC: sha1)."
      ylw "    أعد التصدير بهذا الأمر بالضبط:"
      ylw "      openssl pkcs12 -export -macalg sha1 \\"
      ylw "        -certpbe PBE-SHA1-3DES -keypbe PBE-SHA1-3DES \\"
      ylw "        -inkey <المفتاح.key> -in <الشهادة.pem> -out ios_signing/cert.p12"
    fi

    # ---- تاريخ الانتهاء واستخراج معرّف الفريق ----
    SUBJ="$(p12_read "$P12" "$P12_PASS" -clcerts -nokeys | \
            openssl x509 -noout -subject -enddate 2>/dev/null)"
    if [ -n "$SUBJ" ]; then
      END="$(printf '%s' "$SUBJ" | sed -n 's/^notAfter=//p')"
      [ -n "$END" ] && ok "تنتهي الشهادة: $END"

      # OU في اسم الشهادة هو معرّف الفريق — أدقّ من نسخه باليد من الموقع.
      TEAM_ID="$(printf '%s' "$SUBJ" | sed -n 's/.*OU *= *\([A-Z0-9]\{10\}\).*/\1/p' | head -1)"
      if [ -n "$TEAM_ID" ]; then
        ok "معرّف الفريق (من OU): $TEAM_ID"
        SECRET_ROWS+=("IOS_TEAM_ID|من OU داخل اسم الشهادة|$TEAM_ID")
      else
        ylw "  ! تعذّر استخراج معرّف الفريق من الشهادة — انسخه من developer.apple.com ← Membership."
      fi

      # نوع الشهادة: توقيع App Store يحتاج Apple Distribution. شهادة تطوير
      # تبني وتوقّع بنجاح ثم تُرفض عند الرفع بعد أن يكون البناء انتهى كله.
      if printf '%s' "$SUBJ" | grep -qi 'Apple Distribution\|iPhone Distribution'; then
        ok "نوع الشهادة: توزيع — صالحة لـApp Store."
      else
        fail "الشهادة ليست شهادة توزيع — نسخة App Store تحتاج Apple Distribution."
      fi
    fi
  fi
fi

# ---- تطابق الشهادة مع المفتاح ----
# شهادة بلا مفتاحها ورقة لا تُوقِّع. الخلط وارد حين تتراكم عدة أزواج في
# المجلد، ومقارنة الـmodulus هي الفصل القاطع بينها.
if [ -n "$CERT_FILE" ] && [ -n "$KEY_FILE" ]; then
  # الشهادة قد تكون PEM أو DER (ملف .cer من آبل ينزل DER) — تُجرَّب الصيغتان.
  CERT_MOD="$(openssl x509 -noout -modulus -in "$CERT_FILE" 2>/dev/null \
              || openssl x509 -inform DER -noout -modulus -in "$CERT_FILE" 2>/dev/null)"
  KEY_MOD="$(openssl rsa -noout -modulus -in "$KEY_FILE" 2>/dev/null)"
  # تُقارَن السلسلتان مباشرة لا بصمتاهما: بناء إحداهما بـprintf والأخرى
  # بأنبوب يضيف سطرًا جديدًا لواحدة دون الأخرى، فتختلف البصمتان على زوج
  # مطابق تمامًا ويظهر فشل كاذب يوقف السكربت عن توليد أسرار سليمة.
  if [ -n "$CERT_MOD" ] && [ "$CERT_MOD" = "$KEY_MOD" ]; then
    ok "الشهادة والمفتاح الخاص زوج مطابق."
  else
    fail "الشهادة لا تطابق المفتاح الخاص — لا يصلح أحدهما مع الآخر للتوقيع."
  fi
else
  ylw "  ! .cer/.pem أو .key غير موجودين — تُخطّى مقارنة التطابق (الـp12 وحده يكفي للبناء)."
fi

# ==========================================================================
# ٢) البروفايلات
# ==========================================================================
hdr "بروفايلات التزويد"

check_profile() {
  local file="$1" expected_bundle="$2" secret_name="$3" label="$4"
  echo "  — $(basename "$file")"

  local plist; plist="$(mktemp)"
  # security cms على macOS؛ openssl smime بديل على Linux.
  if command -v security >/dev/null 2>&1; then
    security cms -D -i "$file" > "$plist" 2>/dev/null
  else
    openssl smime -inform DER -verify -noverify -in "$file" > "$plist" 2>/dev/null
  fi
  if [ ! -s "$plist" ]; then
    fail "    تعذّرت قراءة البروفايل — الملف تالف أو ليس .mobileprovision."
    rm -f "$plist"; return
  fi

  local pb=""
  command -v /usr/libexec/PlistBuddy >/dev/null 2>&1 && pb="/usr/libexec/PlistBuddy"
  read_key() {
    if [ -n "$pb" ]; then $pb -c "Print :$1" "$plist" 2>/dev/null
    else grep -A1 "<key>${1##*:}</key>" "$plist" | sed -n 's/.*<string>\(.*\)<\/string>.*/\1/p' | head -1; fi
  }

  local name appid bundle expiry
  name="$(read_key 'Name')"
  appid="$(read_key 'Entitlements:application-identifier')"
  bundle="${appid#*.}"
  expiry="$(read_key 'ExpirationDate')"
  [ -n "$name" ] && echo "    الاسم: $name"

  # معرّف الحزمة: بروفايل التطبيق الآخر يوقّع بنجاح ثم يُرفض عند الرفع.
  if [ "$bundle" = "$expected_bundle" ]; then
    ok "    معرّف الحزمة: $bundle"
  else
    fail "    معرّف الحزمة $bundle بينما $label يحتاج $expected_bundle — بروفايل التطبيق الخطأ."
  fi

  [ -n "$expiry" ] && echo "    ينتهي: $expiry"

  # aps-environment: غيابها يعني تطبيقًا لا تصله إشعارات مهما فعلت بعد ذلك،
  # وهي كل سبب دفع الاشتراك. ولا شيء يشتكي منها إلا حين لا يصل إشعار.
  if grep -q 'aps-environment' "$plist"; then
    ok "    aps-environment موجودة."
  else
    fail "    aps-environment غائبة — أُنشئ البروفايل عن App ID بلا Push Notifications."
    ylw "      المطلوب: Identifiers ← $expected_bundle ← فعّل Push Notifications ← احفظ،"
    ylw "      ثم Profiles ← أعِد توليد البروفايل ← نزّله ← ضعه هنا وأعد التشغيل."
  fi

  # التوقيع بشهادة ليست داخل البروفايل يفشل بـ"no signing certificate matching".
  if [ -n "$TEAM_ID" ] && ! grep -q "$TEAM_ID" "$plist"; then
    fail "    البروفايل لا يذكر معرّف الفريق $TEAM_ID — بروفايل من حساب آخر."
  fi

  SECRET_ROWS+=("$secret_name|$(basename "$file")|<base64>")
  rm -f "$plist"
}

PROFILES="$(find "$SIGN_DIR" -maxdepth 2 -type f -name '*.mobileprovision' 2>/dev/null)"
if [ -z "$PROFILES" ]; then
  fail "لا بروفايلات في ios_signing/ — نزّلها من developer.apple.com (README خطوة ٦)."
else
  # التمييز بالاسم: يكفي أن يحوي اسم الملف customer أو driver.
  P_CUST="$(printf '%s\n' "$PROFILES" | grep -i 'customer' | head -1)"
  P_DRIV="$(printf '%s\n' "$PROFILES" | grep -i 'driver'   | head -1)"

  if [ -n "$P_CUST" ]; then
    check_profile "$P_CUST" "$BUNDLE_CUSTOMER" "IOS_PROFILE_CUSTOMER_BASE64" "تطبيق الزبون"
  else
    fail "لا بروفايل باسم فيه customer — سمِّ الملف بحيث يميّزه (مثلًا AquaGo_Customer_AppStore.mobileprovision)."
  fi

  if [ -n "$P_DRIV" ]; then
    check_profile "$P_DRIV" "$BUNDLE_DRIVER" "IOS_PROFILE_DRIVER_BASE64" "تطبيق السائق"
  else
    fail "لا بروفايل باسم فيه driver — سمِّ الملف بحيث يميّزه (مثلًا AquaGo_Driver_AppStore.mobileprovision)."
  fi
fi

# ==========================================================================
# ٣) مفتاح App Store Connect API
# ==========================================================================
hdr "مفتاح App Store Connect API"

AUTHKEY="$(find_one 'AuthKey_*.p8')"
if [ -z "$AUTHKEY" ]; then
  fail "لا ملف AuthKey_*.p8 — ولّده من App Store Connect ← Users and Access ← Integrations."
  ylw "    ينزل مرة واحدة فقط ولا يمكن تنزيله ثانية — احفظه فور تنزيله."
else
  ok "المفتاح: $(basename "$AUTHKEY")"

  # معرّف المفتاح من اسم الملف: آبل تسمّيه AuthKey_XXXXXXXXXX.p8، فأخذه من
  # الاسم أضمن من نسخه باليد عن الموقع.
  KEY_ID="$(basename "$AUTHKEY" | sed -n 's/^AuthKey_\([A-Z0-9]\{10\}\)\.p8$/\1/p')"
  if [ -n "$KEY_ID" ]; then
    ok "معرّف المفتاح: $KEY_ID"
    SECRET_ROWS+=("APPSTORE_KEY_ID|من اسم ملف AuthKey|$KEY_ID")
  else
    fail "اسم الملف ليس بصيغة AuthKey_XXXXXXXXXX.p8 — أعِد تسميته كما نزّلته من آبل."
  fi

  if grep -q "BEGIN PRIVATE KEY" "$AUTHKEY"; then
    ok "المحتوى مفتاح خاص سليم."
  else
    fail "الملف لا يحوي BEGIN PRIVATE KEY — ليس مفتاح .p8 صالحًا."
  fi

  # مفتاح App Store Connect منحنى P-256. مفتاح Sign in with Apple بنفس
  # الامتداد ونفس الشكل، ووضعه مكانه يعطي 401 عند الرفع تظهر وكأنها مشكلة
  # في Bundle ID — وهذا وقع فعلًا وضاع فيه وقت طويل.
  if openssl ec -in "$AUTHKEY" -noout 2>/dev/null; then
    ok "المفتاح بمنحنى EC — الشكل المتوقّع."
    ylw "  ! تحقّق بعينك أنه مفتاح App Store Connect لا Sign in with Apple:"
    ylw "    الملفان متطابقان شكلًا، والخطأ يظهر 401 بعد رفعة كاملة."
  fi
  SECRET_ROWS+=("APPSTORE_PRIVATE_KEY|محتوى $(basename "$AUTHKEY") كاملًا|<نص المفتاح>")
  SECRET_ROWS+=("APPSTORE_ISSUER_ID|App Store Connect ← Integrations (واحد للحساب)|<انسخه يدويًا>")
fi

# ==========================================================================
# ٤) النتيجة — لا يُطبع سرّ إلا إذا عدّت كل الفحوص
# ==========================================================================
hdr "النتيجة"
if [ "$FAILED" != "0" ]; then
  red "فشل فحص أو أكثر — لم يُولَّد أي سرّ."
  red "أصلح ما فوق ثم أعد التشغيل. سرٌّ مولَّد من ملف غلط يفشل بعد عشر دقائق بناء برسالة لا تدلّ عليه."
  exit 1
fi
grn "كل الفحوص عدّت."

mkdir -p "$OUT_DIR"
# الملفات داخل ios_signing/ وهو كله في .gitignore — لا تخرج من الجهاز.
write_b64() { base64 < "$1" | tr -d '\n' > "$OUT_DIR/$2.txt"; echo "  $OUT_DIR/$2.txt"; }

hdr "ملفات base64 الجاهزة للّصق"
[ -n "${P12:-}" ]     && write_b64 "$P12"     "IOS_CERT_P12_BASE64"
[ -n "${P_CUST:-}" ]  && write_b64 "$P_CUST"  "IOS_PROFILE_CUSTOMER_BASE64"
[ -n "${P_DRIV:-}" ]  && write_b64 "$P_DRIV"  "IOS_PROFILE_DRIVER_BASE64"
[ -n "${PASS_FILE:-}" ] && { tr -d '\r\n' < "$PASS_FILE" > "$OUT_DIR/IOS_CERT_PASSWORD.txt"; echo "  $OUT_DIR/IOS_CERT_PASSWORD.txt"; }
[ -n "${AUTHKEY:-}" ] && { cp "$AUTHKEY" "$OUT_DIR/APPSTORE_PRIVATE_KEY.txt"; echo "  $OUT_DIR/APPSTORE_PRIVATE_KEY.txt"; }

hdr "الأسرار ومصادرها"
printf '  %-32s %-46s %s\n' "السرّ" "المصدر" "القيمة"
printf '  %-32s %-46s %s\n' "--------------------------------" "----------------------------------------------" "----------"
for row in "${SECRET_ROWS[@]}"; do
  IFS='|' read -r n s v <<< "$row"
  printf '  %-32s %-46s %s\n' "$n" "$s" "$v"
done
printf '  %-32s %-46s %s\n' "IOS_CERT_P12_BASE64" "$(basename "${P12:-—}")" "<base64>"
printf '  %-32s %-46s %s\n' "IOS_CERT_PASSWORD" "p12_password.txt" "<كلمة المرور>"

cat <<'EOF'

أضِفها من: Settings ← Secrets and variables ← Actions ← New repository secret
الصق محتوى كل ملف من مجلد base64/ كما هو (بلا أسطر زائدة — الوركفلو ينظّفها
بـtr احتياطًا، لكن لصقًا نظيفًا أفضل).

بعدها: Actions ← "iOS — نسخة موقّعة (TestFlight)" ← Run workflow.
جرّبها أول مرة وupload = false: تبني وتفحص بلا رفع، فتُمسك أخطاء التوقيع
قبل أن تستهلك رفعة على App Store Connect.
EOF
